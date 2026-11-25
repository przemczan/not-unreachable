import { and, isNull, lte, or } from "drizzle-orm";
import { DAY_MS, MINUTE_MS, type Clock, type Db, type JobScheduler } from "../platform/index.ts";
import { FAILURES_FORGOTTEN_AFTER_MS, LOCK_WINDOW_MS } from "./limits.ts";
import { signInFailures, signInLocks } from "./schema.ts";

export const SIGN_IN_LIMITS_SWEEP_JOB = "sign-in-limits-sweep";

export interface SignInLimitsSweepDependencies {
  readonly db: Db;
  readonly clock: Clock;
}

export interface SweptSignInLimits {
  readonly failures: number;
  readonly locks: number;
}

/**
 * Deletes the failure rows no longer remembered and the lock rows whose window and lock are both
 * over. The limits already ignore such rows, so this only keeps the tables bounded: unknown
 * identifiers would otherwise add rows for good.
 */
export function sweepSignInLimits({ db, clock }: SignInLimitsSweepDependencies): SweptSignInLimits {
  const now = clock.now().getTime();
  const nowIso = new Date(now).toISOString();
  const failures = db
    .delete(signInFailures)
    .where(
      and(
        lte(signInFailures.lastFailureAt, new Date(now - FAILURES_FORGOTTEN_AFTER_MS).toISOString()),
        or(isNull(signInFailures.delayedUntil), lte(signInFailures.delayedUntil, nowIso)),
      ),
    )
    .run().changes;
  const locks = db
    .delete(signInLocks)
    .where(
      and(
        lte(signInLocks.windowStartedAt, new Date(now - LOCK_WINDOW_MS).toISOString()),
        or(isNull(signInLocks.lockedUntil), lte(signInLocks.lockedUntil, nowIso)),
      ),
    )
    .run().changes;
  return { failures, locks };
}

/** Sweeps daily, the first time a minute after start, as the audit retention job does. */
export function scheduleSignInLimitsSweep(jobs: JobScheduler, dependencies: SignInLimitsSweepDependencies): void {
  jobs.register({
    name: SIGN_IN_LIMITS_SWEEP_JOB,
    intervalMs: DAY_MS,
    firstRunAfterMs: MINUTE_MS,
    run: () => {
      sweepSignInLimits(dependencies);
    },
  });
}
