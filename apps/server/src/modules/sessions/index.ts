import type { AccountsService } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import type { Clock, Db } from "../platform/index.ts";
import type { SettingsService } from "../settings/index.ts";
import { createSessionsRepository } from "./repository.ts";
import { createSessionsServiceWith, type SessionsService } from "./service.ts";

export { clearedSessionCookie, readSessionToken, SESSION_COOKIE, sessionCookie } from "./cookie.ts";
export { enforceContract, registerSessionGuard, toCaller } from "./guard.ts";
export { createSessionsHandlers, type SessionsRoutes } from "./routes.ts";
export { sessions, type SessionRow } from "./schema.ts";
export {
  type LiveSession,
  type NewSession,
  type RevokeContext,
  type RevokeReason,
  type SessionsService,
  type SignInMethod,
  type StartedSession,
} from "./service.ts";
export { isSessionLive, LAST_SEEN_WRITE_INTERVAL_MS, PENDING_SESSION_LIFETIME_MS, shouldTouch } from "./timeouts.ts";

export interface SessionsDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly settings: SettingsService;
  readonly audit: AuditService;
  readonly accounts: Pick<AccountsService, "findById">;
}

export function createSessionsService({ db, clock, settings, audit, accounts }: SessionsDependencies): SessionsService {
  return createSessionsServiceWith({ repository: createSessionsRepository(db), accounts, settings, audit, clock });
}
