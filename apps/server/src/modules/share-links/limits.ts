import { problemTypes } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import { rateLimitKey } from "../../http/rate-limit.ts";
import type { AuditOrigin, AuditService } from "../audit/index.ts";
import { MINUTE_MS, type Clock } from "../platform/index.ts";
import type { SettingsService } from "../settings/index.ts";

/*
 * The share links' limits (threat model, T8 and T11), kept in memory: the app is one process. Only
 * the lock they lead to is kept in the database (`share_links.locked_until`), so a restart clears the
 * counters but never a lock. The numbers come from the `shareLinkLimits` setting on every request;
 * the windows are fixed, as the setting's names say.
 */

export const SHARE_TOKEN_LIMIT = "share-link-token-per-ip";
export const INVALID_TOKENS_WINDOW_MS = MINUTE_MS;
export const WRONG_PASSWORDS_PER_IP_WINDOW_MS = 15 * MINUTE_MS;
export const WRONG_PASSWORDS_PER_LINK_WINDOW_MS = 60 * MINUTE_MS;

/** How often the stores drop keys with nothing left in their windows. */
const SWEEP_EVERY_MS = 5 * MINUTE_MS;

type Settings = Pick<SettingsService, "get">;

function retryAfter(untilMs: number, nowMs: number): Record<string, string> {
  return { "retry-after": String(Math.max(1, Math.ceil((untilMs - nowMs) / 1000))) };
}

/** Times within a sliding window, oldest first, per key. */
class SlidingWindows {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Adds a hit at `now` and answers how many the window holds with it. */
  hit(key: string, now: number): number {
    const recent = this.recent(key, now);
    recent.push(now);
    this.windows.set(key, recent);
    return recent.length;
  }

  forget(key: string): void {
    this.windows.delete(key);
  }

  sweep(now: number): void {
    for (const key of this.windows.keys()) if (this.recent(key, now).length === 0) this.windows.delete(key);
  }

  private recent(key: string, now: number): number[] {
    return (this.windows.get(key) ?? []).filter((at) => at > now - this.windowMs);
  }
}

export interface ShareTokenLimit {
  /** Throws `429 rate-limited` with `Retry-After` while the IP is blocked. */
  assertAllowed(origin: AuditOrigin): void;
  /**
   * Counts an invalid token (unknown, malformed, expired, revoked or gone). Past the limit it blocks
   * the IP, records `rate-limit.triggered` once for that block, and throws the 429.
   */
  recordInvalid(origin: AuditOrigin): void;
}

export interface ShareTokenLimitDependencies {
  readonly settings: Settings;
  readonly audit: AuditService;
  readonly clock: Clock;
}

export function createShareTokenLimit({ settings, audit, clock }: ShareTokenLimitDependencies): ShareTokenLimit {
  const invalid = new SlidingWindows(INVALID_TOKENS_WINDOW_MS);
  const blockedUntil = new Map<string, number>();
  let lastSweep = clock.now().getTime();

  const sweep = (now: number): void => {
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    invalid.sweep(now);
    for (const [key, until] of blockedUntil) if (until <= now) blockedUntil.delete(key);
  };

  const blocked = (key: string, now: number): HttpProblem | undefined => {
    const until = blockedUntil.get(key);
    return until !== undefined && until > now
      ? new HttpProblem(429, problemTypes.rateLimited, undefined, retryAfter(until, now))
      : undefined;
  };

  return {
    assertAllowed({ ip }) {
      if (ip === null) return;
      const now = clock.now().getTime();
      sweep(now);
      const problem = blocked(rateLimitKey(ip), now);
      if (problem !== undefined) throw problem;
    },

    recordInvalid({ ip, userAgent }) {
      if (ip === null) return;
      const now = clock.now().getTime();
      const key = rateLimitKey(ip);
      const { invalidTokensPerIpPerMinute, invalidTokenBlockMinutes } = settings.get("shareLinkLimits");
      if (invalid.hit(key, now) <= invalidTokensPerIpPerMinute) return;
      invalid.forget(key);
      blockedUntil.set(key, now + invalidTokenBlockMinutes * MINUTE_MS);
      audit.record({
        action: "rate-limit.triggered",
        actor: { kind: "anonymous" },
        outcome: "denied",
        origin: { ip, userAgent },
        details: { limit: SHARE_TOKEN_LIMIT, key },
      });
      throw blocked(key, now) ?? new HttpProblem(429, problemTypes.rateLimited);
    },
  };
}

export type LockReason = "per-ip" | "per-link";

/** A lock a wrong password led to: which limit it reached and until when the link is locked. */
export interface Lock {
  readonly reason: LockReason;
  readonly until: Date;
}

export interface WrongPasswordCounter {
  /** Counts a wrong password; answers the lock it leads to, if any, and then starts both counts over. */
  record(shareLinkId: string, ip: string | null): Lock | undefined;
}

export function createWrongPasswordCounter({
  settings,
  clock,
}: {
  readonly settings: Settings;
  readonly clock: Clock;
}): WrongPasswordCounter {
  const perIp = new SlidingWindows(WRONG_PASSWORDS_PER_IP_WINDOW_MS);
  const perLink = new SlidingWindows(WRONG_PASSWORDS_PER_LINK_WINDOW_MS);
  let lastSweep = clock.now().getTime();

  return {
    record(shareLinkId, ip) {
      const now = clock.now().getTime();
      if (now - lastSweep >= SWEEP_EVERY_MS) {
        lastSweep = now;
        perIp.sweep(now);
        perLink.sweep(now);
      }
      const { wrongPasswordsPerIpPer15Minutes, wrongPasswordsPerLinkPerHour, lockMinutes } = settings.get("shareLinkLimits");
      const ipKey = `${shareLinkId} ${ip === null ? "" : rateLimitKey(ip)}`;
      const reason: LockReason | undefined =
        perIp.hit(ipKey, now) >= wrongPasswordsPerIpPer15Minutes
          ? "per-ip"
          : perLink.hit(shareLinkId, now) >= wrongPasswordsPerLinkPerHour
            ? "per-link"
            : undefined;
      if (reason === undefined) return undefined;
      perIp.forget(ipKey);
      perLink.forget(shareLinkId);
      return { reason, until: new Date(now + lockMinutes * MINUTE_MS) };
    },
  };
}

export interface DownloadSlots {
  /** Takes one of the link's download slots for the IP; throws `429 too-many-downloads` when all are taken. Answers its release. */
  acquire(shareLinkId: string, ip: string | null): () => void;
}

export function createDownloadSlots(settings: Settings): DownloadSlots {
  const taken = new Map<string, number>();
  return {
    acquire(shareLinkId, ip) {
      const key = `${shareLinkId} ${ip === null ? "" : rateLimitKey(ip)}`;
      const count = taken.get(key) ?? 0;
      if (count >= settings.get("shareLinkLimits").concurrentDownloadsPerIp) {
        throw new HttpProblem(429, problemTypes.tooManyDownloads, undefined, { "retry-after": "5" });
      }
      taken.set(key, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (taken.get(key) ?? 1) - 1;
        if (left <= 0) taken.delete(key);
        else taken.set(key, left);
      };
    },
  };
}
