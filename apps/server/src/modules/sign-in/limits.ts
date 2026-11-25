import { problemTypes } from "@not-unreachable/contracts";
import { and, eq } from "drizzle-orm";
import { HttpProblem } from "../../http/index.ts";
import { rateLimitKey } from "../../http/rate-limit.ts";
import { normalizeIdentifier } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import type { Clock, Db, Secrets } from "../platform/index.ts";
import type { SettingsService } from "../settings/index.ts";
import type { SignInAttempt, SignInGate, SignInRefusal } from "./gate.ts";
import { signInFailures, signInLocks } from "./schema.ts";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** The first delay once an IP has `delayAfterFailures` failures for a subject; it doubles per further failure. */
export const FIRST_DELAY_MS = SECOND_MS;
/** The longest delay. */
export const MAX_DELAY_MS = 60 * SECOND_MS;
/** The window over which a subject's failures from every IP count towards a lock. */
export const LOCK_WINDOW_MS = HOUR_MS;
/** An IP's failures for a subject are forgotten this long after the last one, so a delay never lasts for good. */
export const FAILURES_FORGOTTEN_AFTER_MS = HOUR_MS;
/** How often the per-IP store drops addresses that made no attempt within the last hour. */
const SWEEP_EVERY_MS = 5 * MINUTE_MS;

export const perIpLimits = { perMinute: "sign-in-per-ip-per-minute", perHour: "sign-in-per-ip-per-hour" } as const;

type PerIpLimit = (typeof perIpLimits)[keyof typeof perIpLimits];

export interface SignInLimitsDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly settings: SettingsService;
  readonly audit: AuditService;
  /** Keys the hash of identifiers that name no account. */
  readonly secrets: Pick<Secrets, "mac">;
}

interface IpEntry {
  /** Times of the attempts within the last hour, oldest first. */
  attempts: number[];
  /** Per limit, until when its `rate-limit.triggered` is already recorded (once per key per window). */
  readonly auditedUntil: Map<PerIpLimit, number>;
}

/**
 * Whom the delay and the lock count failures for: the account when the identifier names one,
 * otherwise the identifier, normalised as the lookup does and hashed under the master key, so an
 * unknown identifier is limited exactly like an account (T1) and none is stored in a form anyone
 * can guess.
 */
export function subjectKeyOf(attempt: Pick<SignInAttempt, "identifier" | "account">, secrets: Pick<Secrets, "mac">): string {
  if (attempt.account !== undefined) return `account:${attempt.account.id}`;
  return `identifier:${secrets.mac("sign-in-identifier", normalizeIdentifier(attempt.identifier))}`;
}

/** The delay after an IP's `failures`th failure for a subject; 0 before `delayAfter`. */
export function delayAfterFailure(failures: number, delayAfter: number): number {
  if (failures < delayAfter) return 0;
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** Math.min(failures - delayAfter, 30));
}

function tooManyAttempts(retryAt: number, now: number): HttpProblem {
  const seconds = Math.max(1, Math.ceil((retryAt - now) / SECOND_MS));
  return new HttpProblem(429, problemTypes.tooManyAttempts, undefined, { "retry-after": String(seconds) });
}

const later = (iso: string | null, now: number): number | undefined => {
  if (iso === null) return undefined;
  const at = Date.parse(iso);
  return at > now ? at : undefined;
};

/** When the attempts within `windowMs` drop below `max` again; undefined while below it. */
function retryAtFor(attempts: readonly number[], now: number, windowMs: number, max: number): number | undefined {
  const within = attempts.filter((at) => at > now - windowMs);
  if (within.length < max) return undefined;
  return (within[within.length - max] ?? now) + windowMs;
}

/**
 * The sign-in limits of threat model T11: attempts per IP (IPv6 by /64) per minute and per hour, kept
 * in memory; a growing delay per subject (`subjectKeyOf`) and IP after repeated failures, and a
 * temporary lock per subject after many failures from any IP within an hour, both kept in the
 * database. Every refusal
 * is `429 /problems/too-many-attempts` with `Retry-After`. The limits are read from the settings on
 * every attempt, so a change applies at once.
 */
export function createSignInLimits({ db, clock, settings, audit, secrets }: SignInLimitsDependencies): SignInGate {
  const ips = new Map<string, IpEntry>();
  let lastSweep = clock.now().getTime();

  const sweep = (now: number): void => {
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    for (const [key, entry] of ips) {
      const newest = entry.attempts.at(-1) ?? 0;
      const audited = Math.max(0, ...entry.auditedUntil.values());
      if (newest <= now - HOUR_MS && audited <= now) ips.delete(key);
    }
  };

  return {
    beforeAttempt({ ip, userAgent }) {
      const now = clock.now().getTime();
      sweep(now);
      const key = rateLimitKey(ip);
      const entry = ips.get(key) ?? { attempts: [], auditedUntil: new Map<PerIpLimit, number>() };
      ips.set(key, entry);
      entry.attempts = entry.attempts.filter((at) => at > now - HOUR_MS);

      const limits = settings.get("signInLimits");
      const exceeded = (
        [
          [perIpLimits.perMinute, retryAtFor(entry.attempts, now, MINUTE_MS, limits.perIpPerMinute)],
          [perIpLimits.perHour, retryAtFor(entry.attempts, now, HOUR_MS, limits.perIpPerHour)],
        ] as const
      ).filter((pair): pair is readonly [PerIpLimit, number] => pair[1] !== undefined);
      if (exceeded.length === 0) {
        entry.attempts.push(now);
        return;
      }
      for (const [limit, retryAt] of exceeded) {
        if ((entry.auditedUntil.get(limit) ?? 0) > now) continue;
        entry.auditedUntil.set(limit, retryAt);
        audit.record({
          action: "rate-limit.triggered",
          actor: { kind: "anonymous" },
          outcome: "denied",
          origin: { ip, userAgent },
          details: { limit, key },
        });
      }
      throw tooManyAttempts(Math.max(...exceeded.map(([, retryAt]) => retryAt)), now);
    },

    beforePasswordCheck(attempt): SignInRefusal | undefined {
      const now = clock.now().getTime();
      const subjectKey = subjectKeyOf(attempt, secrets);
      const lock = db.select().from(signInLocks).where(eq(signInLocks.subjectKey, subjectKey)).get();
      const lockedUntil = lock === undefined ? undefined : later(lock.lockedUntil, now);
      if (lockedUntil !== undefined) return { reason: "locked", problem: tooManyAttempts(lockedUntil, now) };
      const failures = db
        .select()
        .from(signInFailures)
        .where(and(eq(signInFailures.subjectKey, subjectKey), eq(signInFailures.ipKey, rateLimitKey(attempt.ip))))
        .get();
      const delayedUntil = failures === undefined ? undefined : later(failures.delayedUntil, now);
      if (delayedUntil !== undefined) return { reason: "delayed", problem: tooManyAttempts(delayedUntil, now) };
      return undefined;
    },

    recordFailure(attempt: SignInAttempt) {
      const { account, ip, userAgent } = attempt;
      const subjectKey = subjectKeyOf(attempt, secrets);
      const now = clock.now();
      const nowMs = now.getTime();
      const at = now.toISOString();
      const ipKey = rateLimitKey(ip);
      const limits = settings.get("signInLimits");

      const locked = db.transaction((tx) => {
        const previous = tx
          .select()
          .from(signInFailures)
          .where(and(eq(signInFailures.subjectKey, subjectKey), eq(signInFailures.ipKey, ipKey)))
          .get();
        const remembered = previous !== undefined && Date.parse(previous.lastFailureAt) > nowMs - FAILURES_FORGOTTEN_AFTER_MS;
        const failures = remembered ? previous.failures + 1 : 1;
        const delay = delayAfterFailure(failures, limits.delayAfterFailures);
        const delayedUntil = delay === 0 ? null : new Date(nowMs + delay).toISOString();
        tx.insert(signInFailures)
          .values({ subjectKey, ipKey, failures, lastFailureAt: at, delayedUntil })
          .onConflictDoUpdate({
            target: [signInFailures.subjectKey, signInFailures.ipKey],
            set: { failures, lastFailureAt: at, delayedUntil },
          })
          .run();

        const lock = tx.select().from(signInLocks).where(eq(signInLocks.subjectKey, subjectKey)).get();
        const lockOver = lock?.lockedUntil != null && Date.parse(lock.lockedUntil) <= nowMs;
        const windowOver = lock !== undefined && Date.parse(lock.windowStartedAt) <= nowMs - LOCK_WINDOW_MS;
        const fresh = lock === undefined || lockOver || windowOver;
        const windowStartedAt = fresh ? at : lock.windowStartedAt;
        const subjectFailures = fresh ? 1 : lock.failures + 1;
        const alreadyLocked = !fresh && lock.lockedUntil !== null;
        const lockedUntil = alreadyLocked
          ? lock.lockedUntil
          : subjectFailures >= limits.lockAfterFailures
            ? new Date(nowMs + limits.lockMinutes * MINUTE_MS).toISOString()
            : null;
        tx.insert(signInLocks)
          .values({ subjectKey, windowStartedAt, failures: subjectFailures, lockedUntil })
          .onConflictDoUpdate({ target: signInLocks.subjectKey, set: { windowStartedAt, failures: subjectFailures, lockedUntil } })
          .run();
        return !alreadyLocked && lockedUntil !== null ? { failures: subjectFailures, lockedUntil } : undefined;
      });

      if (locked !== undefined) {
        audit.record({
          action: "sign-in.locked",
          actor: { kind: "system" },
          outcome: "succeeded",
          ...(account === undefined ? {} : { target: { kind: "account", id: account.id } }),
          origin: { ip, userAgent },
          details: locked,
        });
      }
    },

    recordSuccess(attempt) {
      db.delete(signInFailures)
        .where(and(eq(signInFailures.subjectKey, subjectKeyOf(attempt, secrets)), eq(signInFailures.ipKey, rateLimitKey(attempt.ip))))
        .run();
    },
  };
}
