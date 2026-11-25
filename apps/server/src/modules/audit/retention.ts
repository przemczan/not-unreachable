import { DAY_MS, MINUTE_MS, type JobScheduler } from "../platform/index.ts";
import type { AuditService } from "./service.ts";

export const AUDIT_RETENTION_JOB = "audit-retention";

/**
 * Purges expired events daily (threat model, T12). The first run comes a minute after start, so a
 * server restarted more often than daily still purges, without slowing its start.
 */
export function scheduleAuditRetention(jobs: JobScheduler, audit: Pick<AuditService, "purgeExpired">): void {
  jobs.register({
    name: AUDIT_RETENTION_JOB,
    intervalMs: DAY_MS,
    firstRunAfterMs: MINUTE_MS,
    run: () => {
      audit.purgeExpired();
    },
  });
}
