import {
  problemTypes,
  type NewPasskey,
  type PasskeyAuthenticationResponse,
  type PasskeyCreationOptions,
  type PasskeyRequestOptions,
  type RecoveryCodes,
  type SecondFactorMethod,
  type SecondFactorStep,
  type TotpEnrolment,
} from "@not-unreachable/contracts";
import { HttpProblem, type Caller } from "../../http/index.ts";
import type { AccountRecord, AccountsService } from "../accounts/index.ts";
import { actorOf, type AuditDetails, type AuditService } from "../audit/index.ts";
import type { PasskeysService, SecondFactorsService } from "../second-factors/index.ts";
import type { SessionsService } from "../sessions/index.ts";
import { createKeyedSerial } from "./keyed-serial.ts";
import type { RequestOrigin } from "./service.ts";

type During = AuditDetails<"second-factor.failed">["during"];

/** A passed step: the session is active now, with this new token. */
export interface PassedStep {
  readonly account: AccountRecord;
  readonly token: string;
}

/**
 * The sign-in step after the password (threat model, T10). Every method needs a session pending its
 * second factor (403 otherwise). A wrong code answers 401 `secondFactorFailed`; past a try limit the
 * pending session is revoked and the answer is 429 `tooManyAttempts`.
 */
export interface SecondFactorStepService {
  /** `enrol` while the account has no confirmed factor. */
  step(caller: Caller): SecondFactorStep;
  passTotp(caller: Caller, code: string, origin: RequestOrigin): Promise<PassedStep>;
  passRecoveryCode(caller: Caller, code: string, origin: RequestOrigin): Promise<PassedStep>;
  /** A challenge bound to the session for one of the account's passkeys. */
  passkeyOptions(caller: Caller): Promise<PasskeyRequestOptions>;
  /** A wrong or unverifiable assertion counts as a wrong code; a counter that went back is audited as such. */
  passPasskey(caller: Caller, response: PasskeyAuthenticationResponse, origin: RequestOrigin): Promise<PassedStep>;
  /** Refused (409 `secondFactorExists`) once the account has a confirmed factor, as are the next three. */
  startEnrolment(caller: Caller): Promise<TotpEnrolment>;
  /** Confirms the session's enrolment; answers the first recovery codes, shown once. */
  confirmEnrolment(caller: Caller, enrolmentId: string, code: string, origin: RequestOrigin): Promise<RecoveryCodes>;
  /** Starts adding a passkey instead of an authenticator app. */
  startPasskeyEnrolment(caller: Caller): Promise<PasskeyCreationOptions>;
  /** Saves the session's new passkey; answers the first recovery codes, shown once. */
  confirmPasskeyEnrolment(caller: Caller, passkey: NewPasskey, origin: RequestOrigin): Promise<RecoveryCodes>;
  /** After the session enrolled the account's first factor: the codes are saved, so the session goes active. */
  acknowledgeRecoveryCodes(caller: Caller, origin: RequestOrigin): PassedStep;
}

export interface SecondFactorStepDependencies {
  readonly accounts: Pick<AccountsService, "findById">;
  readonly sessions: SessionsService;
  readonly secondFactors: SecondFactorsService;
  readonly passkeys: PasskeysService;
  readonly audit: AuditService;
}

export function createSecondFactorStepWith({
  accounts,
  sessions,
  secondFactors,
  passkeys,
  audit,
}: SecondFactorStepDependencies): SecondFactorStepService {
  const accountOf = (caller: Caller): AccountRecord => {
    if (caller.state !== "pendingSecondFactor") {
      throw new HttpProblem(403, problemTypes.forbidden, "This session has passed its second step already.");
    }
    const account = accounts.findById(caller.accountId);
    if (account === undefined) throw new HttpProblem(401, problemTypes.signInRequired);
    return account;
  };

  const refuseOnceEnrolled = (account: AccountRecord): void => {
    if (secondFactors.hasSecondFactor(account.id)) {
      throw new HttpProblem(409, problemTypes.secondFactorExists, "Sign in with your second factor instead.");
    }
  };

  const tooManyAttempts = (caller: Caller, origin: RequestOrigin): HttpProblem => {
    sessions.revoke(caller.accountId, caller.sessionId, "second-factor-limit", { actor: actorOf(caller), origin });
    return new HttpProblem(429, problemTypes.tooManyAttempts, "Too many wrong codes. Sign in again.");
  };

  /** Past a limit already, the pending session can't try again. */
  const requireTriesLeft = (caller: Caller, origin: RequestOrigin): void => {
    if (!secondFactors.withinTryLimits(caller.accountId, caller.sessionId)) throw tooManyAttempts(caller, origin);
  };

  const failed = (
    caller: Caller,
    method: SecondFactorMethod,
    during: During,
    origin: RequestOrigin,
    reason?: AuditDetails<"second-factor.failed">["reason"],
  ): HttpProblem => {
    const limitReached = secondFactors.recordFailure({
      accountId: caller.accountId,
      sessionId: caller.sessionId,
      method,
      during,
      ...(reason === undefined ? {} : { reason }),
      actor: actorOf(caller),
      origin,
    });
    if (limitReached) return tooManyAttempts(caller, origin);
    const detail = method === "passkey" ? "The passkey didn't pass. Try again." : "The code is not right.";
    return new HttpProblem(401, problemTypes.secondFactorFailed, detail);
  };

  // One try at a time per account (T11): a try checks the limits, awaits a slow proof, then counts its
  // failure, so parallel tries would otherwise all pass the check before any of them is counted.
  const tries = createKeyedSerial();
  const oneTryAtATime = <T>(caller: Caller, work: () => Promise<T>): Promise<T> => tries.run(caller.accountId, work);

  const pass = (caller: Caller, account: AccountRecord, secondFactor: SecondFactorMethod, origin: RequestOrigin): PassedStep => {
    // Read before activating: the first step's method stays with the session.
    // A passwordless session starts active, so a pending one began with the password or SSO.
    const method = sessions.findLive(caller.sessionId)?.signInMethod === "sso" ? "sso" : "password";
    const token = sessions.activate(caller.sessionId);
    audit.record({
      action: "sign-in.succeeded",
      actor: actorOf(caller),
      outcome: "succeeded",
      target: { kind: "account", id: account.id },
      origin,
      details: { method, secondFactor },
    });
    return { account, token };
  };

  return {
    step(caller) {
      const account = accountOf(caller);
      if (!secondFactors.hasSecondFactor(account.id)) return { mode: "enrol", methods: [] };
      return { mode: "verify", methods: secondFactors.methods(account.id) };
    },

    passTotp: (caller, code, origin) =>
      oneTryAtATime(caller, async () => {
        const account = accountOf(caller);
        requireTriesLeft(caller, origin);
        if (!secondFactors.verifyTotp(account.id, code)) throw failed(caller, "totp", "sign-in", origin);
        return pass(caller, account, "totp", origin);
      }),

    passRecoveryCode: (caller, code, origin) =>
      oneTryAtATime(caller, async () => {
        const account = accountOf(caller);
        requireTriesLeft(caller, origin);
        const used = await secondFactors.useRecoveryCode(account.id, code, { actor: actorOf(caller), origin });
        if (!used) throw failed(caller, "recoveryCode", "sign-in", origin);
        return pass(caller, account, "recoveryCode", origin);
      }),

    async passkeyOptions(caller) {
      const account = accountOf(caller);
      return passkeys.accountAssertionOptions("second-factor", account.id, caller.sessionId);
    },

    passPasskey: (caller, response, origin) =>
      oneTryAtATime(caller, async () => {
        const account = accountOf(caller);
        requireTriesLeft(caller, origin);
        const result = await passkeys.verifyAccountAssertion("second-factor", account.id, caller.sessionId, response);
        if (!result.passed) {
          throw failed(caller, "passkey", "sign-in", origin, result.reason === "counter" ? "counter" : undefined);
        }
        return pass(caller, account, "passkey", origin);
      }),

    async startEnrolment(caller) {
      const account = accountOf(caller);
      refuseOnceEnrolled(account);
      return secondFactors.startTotpEnrolment(account, caller.sessionId);
    },

    confirmEnrolment: (caller, enrolmentId, code, origin) =>
      oneTryAtATime(caller, async () => {
        const account = accountOf(caller);
        refuseOnceEnrolled(account);
        requireTriesLeft(caller, origin);
        const confirmed = await secondFactors.confirmTotpEnrolment(account, enrolmentId, code, caller.sessionId, {
          actor: actorOf(caller),
          origin,
        });
        if (confirmed === undefined) throw failed(caller, "totp", "enrolment", origin);
        if (confirmed.recoveryCodes === null) throw new HttpProblem(409, problemTypes.secondFactorExists);
        return { recoveryCodes: confirmed.recoveryCodes };
      }),

    async startPasskeyEnrolment(caller) {
      const account = accountOf(caller);
      refuseOnceEnrolled(account);
      return passkeys.registrationOptions(account, caller.sessionId);
    },

    confirmPasskeyEnrolment: (caller, passkey, origin) =>
      oneTryAtATime(caller, async () => {
        const account = accountOf(caller);
        refuseOnceEnrolled(account);
        requireTriesLeft(caller, origin);
        const added = await passkeys.register(account, passkey, caller.sessionId, { actor: actorOf(caller), origin });
        if (added === undefined) throw failed(caller, "passkey", "enrolment", origin);
        if (added.recoveryCodes === null) throw new HttpProblem(409, problemTypes.secondFactorExists);
        return { recoveryCodes: added.recoveryCodes };
      }),

    acknowledgeRecoveryCodes(caller, origin) {
      const account = accountOf(caller);
      const enrolled = secondFactors.enrolledInSession(account.id, caller.sessionId);
      if (enrolled === undefined) {
        throw new HttpProblem(409, problemTypes.secondFactorExists, "Sign in with your second factor instead.");
      }
      return pass(caller, account, enrolled, origin);
    },
  };
}
