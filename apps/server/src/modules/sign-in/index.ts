import type { AccountsService } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import type { PasskeysService, SecondFactorsService } from "../second-factors/index.ts";
import type { SessionsService } from "../sessions/index.ts";
import { openSignInGate, type SignInGate } from "./gate.ts";
import { createSecondFactorStepWith, type SecondFactorStepService } from "./second-factor-step.ts";
import { createSignInServiceWith, type SignInService } from "./service.ts";

export {
  openSignInGate,
  type AttemptKind,
  type PasswordProofKind,
  type SignInAttempt,
  type SignInGate,
  type SignInRefusal,
} from "./gate.ts";
export { createSignInLimits, delayAfterFailure, perIpLimits, subjectKeyOf, type SignInLimitsDependencies } from "./limits.ts";
export { createSecondFactorStepHandlers, type SecondFactorStepRoutes } from "./second-factor-routes.ts";
export { type PassedStep, type SecondFactorStepService } from "./second-factor-step.ts";
export { createSignInHandlers, type SignInRoutes } from "./routes.ts";
export { clearedWebAuthnCookie, readWebAuthnToken, WEBAUTHN_COOKIE, webAuthnCookie } from "./webauthn-cookie.ts";
export { signInFailures, signInLocks, type SignInFailureRow, type SignInLockRow } from "./schema.ts";
export { signInFailed, type Credentials, type RequestOrigin, type SignInService } from "./service.ts";
export { createSsoSignInPurpose, type SsoSignInDependencies } from "./sso-sign-in.ts";
export {
  scheduleSignInLimitsSweep,
  SIGN_IN_LIMITS_SWEEP_JOB,
  sweepSignInLimits,
  type SignInLimitsSweepDependencies,
  type SweptSignInLimits,
} from "./sweep.ts";

export interface SignInDependencies {
  readonly accounts: AccountsService;
  readonly sessions: SessionsService;
  readonly secondFactors: SecondFactorsService;
  readonly passkeys: PasskeysService;
  readonly audit: AuditService;
  /** The sign-in limits (threat model, T11); none when left out. */
  readonly gate?: SignInGate;
}

export function createSignInService({ gate, ...dependencies }: SignInDependencies): SignInService {
  return createSignInServiceWith({ ...dependencies, gate: gate ?? openSignInGate });
}

export function createSecondFactorStep(dependencies: Omit<SignInDependencies, "gate">): SecondFactorStepService {
  return createSecondFactorStepWith(dependencies);
}
