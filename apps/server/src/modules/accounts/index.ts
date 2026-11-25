import { systemTimers, type Clock, type Db, type Logger } from "../platform/index.ts";
import type { AuditService } from "../audit/index.ts";
import { createConcurrencyLimiter, HASHING_CONCURRENCY, HASHING_QUEUE_TIMEOUT_MS } from "./limiter.ts";
import { createPasswordHasher, passwordHashingParameters, type PasswordHasher, type PasswordHashingParameters } from "./password-hasher.ts";
import { createAccountsRepository } from "./repository.ts";
import { createAccountsServiceWith, type AccountsService } from "./service.ts";
import { createSetupServiceWith, type SetupService } from "./setup.ts";

/** The table only for other modules' foreign keys: they reach account data through the accounts service (rule 2). */
export { users } from "./schema.ts";
export {
  createConcurrencyLimiter,
  HASHING_CONCURRENCY,
  HASHING_QUEUE_TIMEOUT_MS,
  PasswordHashingBusyError,
  type ConcurrencyLimiter,
} from "./limiter.ts";
export { createPasswordHasher, passwordHashingParameters, type PasswordHasher, type PasswordHashingParameters } from "./password-hasher.ts";
export { assertAcceptablePassword, passwordProblem, type PasswordProblem } from "./password-rules.ts";
export { createAccountsHandlers, type AccountsRoutes } from "./routes.ts";
export {
  normalizeIdentifier,
  toAccount,
  type AccountRecord,
  type AccountsService,
  type AccountStatus,
  type NewAccount,
  type PasswordCheck,
  type ProfileChange,
  type ProfileField,
} from "./service.ts";
export {
  AdminExistsError,
  NoAdminError,
  SETUP_TOKEN_LIFETIME_MS,
  type IssuedSetupToken,
  type SetupPurpose,
  type SetupService,
} from "./setup.ts";

export interface AccountsDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  /** The stack.md parameters unless given; tests pass cheap ones. */
  readonly passwordHashing?: PasswordHashingParameters;
}

export interface AccountsModule {
  readonly accounts: AccountsService;
  readonly setup: SetupService;
  /** For other credentials hashed like passwords, such as recovery codes, under the same concurrency limit. */
  readonly hasher: PasswordHasher;
}

/** The accounts and setup services, sharing one password hasher whose limiter holds for the whole process. */
export function createAccountsModule({ db, clock, logger, audit, passwordHashing }: AccountsDependencies): AccountsModule {
  const repository = createAccountsRepository(db);
  const limiter = createConcurrencyLimiter({
    concurrency: HASHING_CONCURRENCY,
    queueTimeoutMs: HASHING_QUEUE_TIMEOUT_MS,
    timers: systemTimers,
  });
  const hasher = createPasswordHasher(passwordHashing ?? passwordHashingParameters, limiter);
  return {
    accounts: createAccountsServiceWith({ repository, hasher, audit, clock, logger }),
    setup: createSetupServiceWith({ repository, hasher, audit, clock }),
    hasher,
  };
}
