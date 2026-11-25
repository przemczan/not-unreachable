import type { Clock, Db, Logger } from "../platform/index.ts";
import type { SettingsService } from "../settings/index.ts";
import { createAuditRepository } from "./repository.ts";
import { createAuditServiceWith, type AuditService } from "./service.ts";

export {
  actorOf,
  auditDetailsSchemas,
  type AuditActor,
  type AuditDetails,
  type AuditEventInput,
  type AuditOrigin,
  type AuditTarget,
} from "./events.ts";
export { AUDIT_RETENTION_JOB, scheduleAuditRetention } from "./retention.ts";
export { createAuditHandlers, type AuditRoutes } from "./routes.ts";
export { auditEvents, type AuditEventRow } from "./schema.ts";
export {
  AUDIT_EXPORT_MAX_ROWS,
  InvalidAuditCursorError,
  USER_AGENT_MAX_CHARACTERS,
  type AuditPageQuery,
  type AuditService,
} from "./service.ts";

export interface AuditDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: SettingsService;
}

export function createAuditService({ db, clock, logger, settings }: AuditDependencies): AuditService {
  return createAuditServiceWith(createAuditRepository(db), clock, logger, settings);
}
