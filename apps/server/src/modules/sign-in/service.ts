import {
  problemTypes,
  type PasskeyAuthenticationResponse,
  type PasskeyRequestOptions,
  type Reauthentication,
  type SessionConfirmation,
} from "@not-unreachable/contracts";
import { HttpProblem, type Caller } from "../../http/index.ts";
import {
  assertAcceptablePassword,
  normalizeIdentifier,
  type AccountRecord,
  type AccountsService,
  type PasswordCheck,
} from "../accounts/index.ts";
import { actorOf, type AuditActor, type AuditDetails, type AuditOrigin, type AuditService } from "../audit/index.ts";
import type { AssertionFailure, PasskeysService, SecondFactorsService } from "../second-factors/index.ts";
import type { SessionsService, StartedSession } from "../sessions/index.ts";
import type { SignInAttempt, SignInGate } from "./gate.ts";
import { createKeyedSerial } from "./keyed-serial.ts";

type FailureReason = Extract<AuditDetails<"sign-in.failed">, { method: "password" }>["reason"];

/** Where a request came from; `request.requestContext` is one. */
export interface RequestOrigin extends AuditOrigin {
  readonly ip: string;
}

export interface Credentials {
  /** A username or an email. */
  readonly identifier: string;
  readonly password: string;
}

export interface SignInService {
  /**
   * Starts a session pending its second factor (threat model, T10), ending `replacing` (the
   * browser's earlier session) so its token stops working. Every failure is the same 401 `signInFailed`.
   */
  signIn(credentials: Credentials, origin: RequestOrigin, replacing: Caller | null): Promise<StartedSession>;
  /** Passwordless: a challenge bound to `browserToken`, the `__Host-nu_webauthn` cookie's. */
  passkeySignInOptions(browserToken: string): Promise<PasskeyRequestOptions>;
  /**
   * Passwordless: a passkey with user verification counts as both steps, so the session is active at
   * once with a recent sign-in. Under the per-IP sign-in limits; every failure is the same 401
   * `signInFailed` as a failed password sign-in (threat model, T1 and T10).
   */
  passkeySignIn(
    browserToken: string | undefined,
    response: PasskeyAuthenticationResponse,
    origin: RequestOrigin,
    replacing: Caller | null,
  ): Promise<StartedSession>;
  /** The challenge for renewing the caller's recent sign-in with a passkey. */
  passkeyConfirmationOptions(caller: Caller): Promise<PasskeyRequestOptions>;
  /**
   * Renews the caller's recent sign-in after checking the password, an authenticator code or a passkey
   * (401 `secondFactorFailed` when wrong, 429 past the try limits); answers the session's new token.
   */
  confirm(caller: Caller, confirmation: SessionConfirmation, origin: RequestOrigin): Promise<string>;
  /**
   * A fresh proof of both factors for one sensitive action (allowing a folder from the admin
   * interface): the password, then, only once it passed, an authenticator code or a passkey over the
   * `confirm` challenge. Each is checked exactly as `confirm` checks it, under the same limits, audit
   * records and problems; neither the session's token nor its recent sign-in changes.
   */
  reauthenticate(caller: Caller, reauthentication: Reauthentication, origin: RequestOrigin): Promise<void>;
  /**
   * Checks the current password (401 `signInFailed`) and the new one's rules (422), stores it,
   * signs out every other session of the account and rotates this one; answers its new token.
   */
  changePassword(caller: Caller, currentPassword: string, newPassword: string, origin: RequestOrigin): Promise<string>;
  /** Ends the caller's session and records `sign-out`. */
  signOut(caller: Caller, origin: RequestOrigin): void;
}

export interface SignInServiceDependencies {
  readonly accounts: AccountsService;
  readonly sessions: SessionsService;
  readonly secondFactors: SecondFactorsService;
  readonly passkeys: PasskeysService;
  readonly audit: AuditService;
  readonly gate: SignInGate;
}

/** A recent-sign-in renewal by a second factor: an authenticator code or a passkey. */
type FactorConfirmation = Exclude<SessionConfirmation, { password: string }>;

/** The one answer to every failed sign-in, whatever the reason (threat model, T1). */
export function signInFailed(): HttpProblem {
  return new HttpProblem(401, problemTypes.signInFailed);
}

function failureReason(account: AccountRecord | undefined, check: PasswordCheck): FailureReason | undefined {
  if (account === undefined) return "unknown-account";
  if (check === "no-password") return "no-password";
  if (check === "wrong-password") return "wrong-password";
  if (account.status !== "active") return "disabled";
  // Only the admin has a password (threat model, T1): a user's stored hash, were there one, proves nothing.
  if (account.role !== "admin") return "no-password";
  return undefined;
}

export function createSignInServiceWith({
  accounts,
  sessions,
  secondFactors,
  passkeys,
  audit,
  gate,
}: SignInServiceDependencies): SignInService {
  const recordFailure = (attempt: SignInAttempt, reason: FailureReason, actor: AuditActor, origin: RequestOrigin): void => {
    audit.record({
      action: "sign-in.failed",
      actor,
      outcome: "failed",
      ...(attempt.account === undefined ? {} : { target: { kind: "account", id: attempt.account.id } }),
      origin,
      details: { method: "password", reason },
    });
  };

  /** One password proof through the gate: answers the account, or throws after recording why. */
  const proveNow = async (attempt: SignInAttempt, password: string, actor: AuditActor, origin: RequestOrigin): Promise<AccountRecord> => {
    const refusal = await gate.beforePasswordCheck(attempt);
    if (refusal !== undefined) {
      recordFailure(attempt, refusal.reason, actor, origin);
      throw refusal.problem;
    }
    const check = await accounts.checkPassword(attempt.account, password);
    const reason = failureReason(attempt.account, check);
    if (reason !== undefined || attempt.account === undefined) {
      await gate.recordFailure(attempt);
      recordFailure(attempt, reason ?? "unknown-account", actor, origin);
      throw signInFailed();
    }
    await gate.recordSuccess({ ...attempt, account: attempt.account });
    return attempt.account;
  };

  // One proof at a time per subject (T11): otherwise parallel tries would all pass the delay and
  // the lock while argon2 runs, before any of their failures is counted.
  const proofs = createKeyedSerial();
  const prove = (attempt: SignInAttempt, password: string, actor: AuditActor, origin: RequestOrigin): Promise<AccountRecord> => {
    const subject =
      attempt.account === undefined ? `identifier:${normalizeIdentifier(attempt.identifier)}` : `account:${attempt.account.id}`;
    return proofs.run(subject, () => proveNow(attempt, password, actor, origin));
  };

  /** A proof by an account already signed in. */
  const proveCaller = async (
    kind: SignInAttempt["kind"],
    caller: Caller,
    password: string,
    origin: RequestOrigin,
  ): Promise<AccountRecord> => {
    await gate.beforeAttempt({ kind, ip: origin.ip, userAgent: origin.userAgent });
    return prove(
      { kind, ip: origin.ip, userAgent: origin.userAgent, identifier: caller.username, account: accounts.findById(caller.accountId) },
      password,
      actorOf(caller),
      origin,
    );
  };

  /** A second factor of the caller's, counted against the try limits of T10. */
  const proveFactor = async (caller: Caller, confirmation: FactorConfirmation, origin: RequestOrigin): Promise<void> => {
    await gate.beforeAttempt({ kind: "confirm", ip: origin.ip, userAgent: origin.userAgent });
    if (!secondFactors.withinTryLimits(caller.accountId, caller.sessionId)) {
      throw new HttpProblem(429, problemTypes.tooManyAttempts, "Too many wrong codes. Try again later, or use your password.");
    }
    let reason: "counter" | undefined;
    if ("code" in confirmation) {
      if (secondFactors.verifyTotp(caller.accountId, confirmation.code)) return;
    } else {
      const result = await passkeys.verifyAccountAssertion("confirm", caller.accountId, caller.sessionId, confirmation.passkey);
      if (result.passed) return;
      if (result.reason === "counter") reason = "counter";
    }
    const method = "code" in confirmation ? "totp" : "passkey";
    secondFactors.recordFailure({
      accountId: caller.accountId,
      sessionId: caller.sessionId,
      method,
      during: "confirm",
      ...(reason === undefined ? {} : { reason }),
      actor: actorOf(caller),
      origin,
    });
    throw new HttpProblem(401, problemTypes.secondFactorFailed, method === "totp" ? "The code is not right." : "The passkey didn't pass.");
  };

  const recordPasskeyFailure = (reason: AssertionFailure | "disabled", accountId: string | undefined, origin: RequestOrigin): void => {
    audit.record({
      action: "sign-in.failed",
      actor: { kind: "anonymous" },
      outcome: "failed",
      ...(accountId === undefined ? {} : { target: { kind: "account", id: accountId } }),
      origin,
      details: { method: "passkey", reason },
    });
  };

  return {
    async signIn({ identifier, password }, origin, replacing) {
      await gate.beforeAttempt({ kind: "sign-in", ip: origin.ip, userAgent: origin.userAgent });
      const attempt: SignInAttempt = {
        kind: "sign-in",
        ip: origin.ip,
        userAgent: origin.userAgent,
        identifier,
        account: accounts.findByIdentifier(identifier),
      };
      const account = await prove(attempt, password, { kind: "anonymous" }, origin);
      if (replacing !== null) sessions.end(replacing.sessionId);
      // Only the admin has a password, and always a second step: `sign-in.succeeded` waits for it.
      return sessions.start({ account, state: "pendingSecondFactor", recentSignIn: false, origin });
    },

    async passkeySignInOptions(browserToken) {
      return passkeys.passwordlessOptions(browserToken);
    },

    async passkeySignIn(browserToken, response, origin, replacing) {
      await gate.beforeAttempt({ kind: "passkey", ip: origin.ip, userAgent: origin.userAgent });
      if (browserToken === undefined) {
        recordPasskeyFailure("invalid-challenge", undefined, origin);
        throw signInFailed();
      }
      const result = await passkeys.verifyPasswordless(browserToken, response);
      if (!result.passed) {
        if (result.reason === "counter" && result.accountId !== undefined) {
          audit.record({
            action: "second-factor.failed",
            actor: { kind: "anonymous" },
            outcome: "failed",
            target: { kind: "account", id: result.accountId },
            origin,
            details: { method: "passkey", during: "sign-in", limitReached: false, reason: "counter" },
          });
        }
        recordPasskeyFailure(result.reason, result.accountId, origin);
        throw signInFailed();
      }
      const account = accounts.findById(result.accountId);
      if (account?.status !== "active") {
        recordPasskeyFailure("disabled", result.accountId, origin);
        throw signInFailed();
      }
      if (replacing !== null) sessions.end(replacing.sessionId);
      const started = sessions.start({ account, state: "active", recentSignIn: true, method: "passkey", origin });
      audit.record({
        action: "sign-in.succeeded",
        actor: actorOf({ accountId: account.id, username: account.username }),
        outcome: "succeeded",
        target: { kind: "account", id: account.id },
        origin,
        details: { method: "passkey", secondFactor: null },
      });
      return started;
    },

    async passkeyConfirmationOptions(caller) {
      return passkeys.accountAssertionOptions("confirm", caller.accountId, caller.sessionId);
    },

    async confirm(caller, confirmation, origin) {
      if ("password" in confirmation) await proveCaller("confirm", caller, confirmation.password, origin);
      else await proofs.run(`account:${caller.accountId}`, () => proveFactor(caller, confirmation, origin));
      return sessions.rotate(caller.sessionId, { renewRecentSignIn: true });
    },

    async reauthenticate(caller, { password, secondFactor }, origin) {
      await proveCaller("confirm", caller, password, origin);
      await proofs.run(`account:${caller.accountId}`, () => proveFactor(caller, secondFactor, origin));
    },

    async changePassword(caller, currentPassword, newPassword, origin) {
      assertAcceptablePassword(newPassword);
      const account = await proveCaller("password-change", caller, currentPassword, origin);
      await accounts.setPassword(account.id, newPassword);
      const context = { actor: actorOf(caller), origin };
      const revokedSessions = sessions.revokeOthers(account.id, caller.sessionId, "password-changed", context);
      const token = sessions.rotate(caller.sessionId, { renewRecentSignIn: true });
      audit.record({
        action: "password.changed",
        actor: actorOf(caller),
        outcome: "succeeded",
        target: { kind: "account", id: account.id },
        origin,
        details: { revokedSessions },
      });
      return token;
    },

    signOut(caller, origin) {
      sessions.end(caller.sessionId);
      audit.record({
        action: "sign-out",
        actor: actorOf(caller),
        outcome: "succeeded",
        target: { kind: "session", id: caller.sessionId },
        origin,
        details: {},
      });
    },
  };
}
