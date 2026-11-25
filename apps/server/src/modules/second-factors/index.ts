import type { PasswordHasher } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import { MINUTE_MS, type Clock, type Db, type JobScheduler, type Secrets } from "../platform/index.ts";
import { auditOnlyNotices, type SecurityNotices } from "./notices.ts";
import { createPasskeysRepository } from "./passkey-repository.ts";
import { createPasskeysServiceWith, type PasskeysService } from "./passkeys.ts";
import { createRelyingParty } from "./relying-party.ts";
import { createSecondFactorsRepository } from "./repository.ts";
import { createSecondFactorsServiceWith, type SecondFactorsService } from "./service.ts";

export {
  auditOnlyNotices,
  createMailedNotices,
  type MailedNoticesDependencies,
  type SecurityNotice,
  type SecurityNotices,
} from "./notices.ts";
export { createPasskeysHandlers, type PasskeysRoutes } from "./passkey-routes.ts";
export {
  WEBAUTHN_CHALLENGE_LIFETIME_MS,
  type AccountAssertionPurpose,
  type AssertionFailure,
  type AssertionResult,
  type PasskeysService,
} from "./passkeys.ts";
export { RELYING_PARTY_NAME } from "./relying-party.ts";
export { formatRecoveryCode, newRecoveryCode, newRecoveryCodes, normalizeRecoveryCode } from "./recovery-codes.ts";
export { createSecondFactorsHandlers, type SecondFactorsRoutes } from "./routes.ts";
export {
  passkeyCredentials,
  recoveryCodes,
  secondFactorFailures,
  totpCredentials,
  webAuthnChallenges,
  type PasskeyCredentialRow,
  type RecoveryCodeRow,
  type SecondFactorFailureRow,
  type TotpCredentialRow,
  type WebAuthnChallengeRow,
} from "./schema.ts";
export {
  secondFactorTryLimits,
  TOTP_ENROLMENT_LIFETIME_MS,
  TOTP_ISSUER,
  type ActionContext,
  type ConfirmedEnrolment,
  type FailedTry,
  type RemovedFactor,
  type RemovedSecondFactors,
  type SecondFactorsService,
} from "./service.ts";
export { codesEqual, matchTotpStep, newTotpSecret, totpCodeForStep, totpStepAt, TOTP_PERIOD_SECONDS } from "./totp.ts";

export const SECOND_FACTORS_SWEEP_JOB = "second-factors-sweep";

export interface SecondFactorsDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditService;
  /** The accounts module's hasher, so recovery codes share its concurrency limit. */
  readonly hasher: Pick<PasswordHasher, "hash" | "verify">;
  readonly secrets: Secrets | undefined;
  /** `PUBLIC_ORIGIN`: the passkeys' RP ID is its host, and their origin must be it exactly. */
  readonly publicOrigin: string;
  /** Audit only when left out. */
  readonly notices?: SecurityNotices;
}

export interface SecondFactorsModule {
  readonly secondFactors: SecondFactorsService;
  readonly passkeys: PasskeysService;
}

export function createSecondFactorsModule({
  db,
  clock,
  audit,
  hasher,
  secrets,
  publicOrigin,
  notices = auditOnlyNotices,
}: SecondFactorsDependencies): SecondFactorsModule {
  const passkeysRepository = createPasskeysRepository(db);
  const secondFactors = createSecondFactorsServiceWith({
    repository: createSecondFactorsRepository(db),
    passkeys: passkeysRepository,
    hasher,
    secrets,
    audit,
    notices,
    clock,
  });
  const passkeys = createPasskeysServiceWith({
    repository: passkeysRepository,
    relyingParty: createRelyingParty(publicOrigin),
    secondFactors,
    audit,
    notices,
    clock,
  });
  return { secondFactors, passkeys };
}

/**
 * Deletes void enrolments, old failures and used or void WebAuthn challenges every 5 minutes; a
 * confirm refuses a void enrolment or challenge either way.
 */
export function scheduleSecondFactorsSweep(jobs: JobScheduler, { secondFactors, passkeys }: SecondFactorsModule): void {
  jobs.register({
    name: SECOND_FACTORS_SWEEP_JOB,
    intervalMs: 5 * MINUTE_MS,
    firstRunAfterMs: MINUTE_MS,
    run: () => {
      secondFactors.sweep();
      passkeys.sweep();
    },
  });
}
