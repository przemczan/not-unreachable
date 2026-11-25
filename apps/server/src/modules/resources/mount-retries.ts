import { MINUTE_MS, type Clock, type JobScheduler } from "../platform/index.ts";
import type { ResourcesService } from "./service.ts";

export const RESOURCE_MOUNT_RETRIES_JOB = "resource-mount-retries";

/** After the 1st, 2nd and 3rd failure in a row; every 10 minutes after that (smb.md). */
const BACKOFF_MS = [1, 2, 5].map((minutes) => minutes * MINUTE_MS);
const STEADY_BACKOFF_MS = 10 * MINUTE_MS;

/** When each share that failed to mount is tried again; kept in memory, so a restart starts over. */
export interface MountRetries {
  recordFailure(id: string): void;
  recordSuccess(id: string): void;
  forget(id: string): void;
  /** The ids whose next retry is due now. */
  due(): string[];
}

interface Backoff {
  readonly failures: number;
  readonly nextAt: number;
}

export function createMountRetries(clock: Clock): MountRetries {
  const backoffs = new Map<string, Backoff>();
  const forget = (id: string): void => {
    backoffs.delete(id);
  };

  return {
    recordFailure(id) {
      const failures = (backoffs.get(id)?.failures ?? 0) + 1;
      const delay = BACKOFF_MS[failures - 1] ?? STEADY_BACKOFF_MS;
      backoffs.set(id, { failures, nextAt: clock.now().getTime() + delay });
    },
    recordSuccess: forget,
    forget,
    due() {
      const now = clock.now().getTime();
      return [...backoffs].filter(([, backoff]) => backoff.nextAt <= now).map(([id]) => id);
    },
  };
}

/** Checks every minute for shares whose retry is due (the backoff itself is in {@link MountRetries}). */
export function scheduleResourceRetries(jobs: JobScheduler, resources: Pick<ResourcesService, "retryDue">): void {
  jobs.register({
    name: RESOURCE_MOUNT_RETRIES_JOB,
    intervalMs: MINUTE_MS,
    firstRunAfterMs: MINUTE_MS,
    run: async () => {
      await resources.retryDue();
    },
  });
}
