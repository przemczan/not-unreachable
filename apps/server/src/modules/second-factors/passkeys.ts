import type {
  AddedPasskey,
  NewPasskey,
  Passkey,
  PasskeyAuthenticationResponse,
  PasskeyCreationOptions,
  PasskeyRequestOptions,
} from "@not-unreachable/contracts";
import type { AccountRecord } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import { hashToken, MINUTE_MS, newId, type Clock } from "../platform/index.ts";
import type { SecurityNotices } from "./notices.ts";
import type { ChallengeBinding, PasskeysRepository } from "./passkey-repository.ts";
import type { RelyingParty, UserVerification } from "./relying-party.ts";
import type { PasskeyCredentialRow, WebAuthnChallengePurpose } from "./schema.ts";
import type { ActionContext, RemovedFactor, SecondFactorsService } from "./service.ts";

/** A challenge is void this long after it is issued (threat model, T10). */
export const WEBAUTHN_CHALLENGE_LIFETIME_MS = 5 * MINUTE_MS;

/** The ceremonies that sign in an account already known: the second-factor step, or renewing a recent sign-in. */
export type AccountAssertionPurpose = Extract<WebAuthnChallengePurpose, "second-factor" | "confirm">;

/** Why an assertion didn't pass; only `sign-in.failed` and `second-factor.failed` ever say which. */
export type AssertionFailure = "invalid-challenge" | "unknown-passkey" | "user-handle-mismatch" | "not-verified" | "counter";

export type AssertionResult =
  | { readonly passed: true; readonly accountId: string }
  | { readonly passed: false; readonly reason: AssertionFailure; readonly accountId?: string };

export interface PasskeysService {
  /** The account's passkeys, oldest first. */
  list(accountId: string): Passkey[];
  /** Starts adding a passkey in the session: a challenge bound to it, and the account's passkeys excluded. */
  registrationOptions(account: AccountRecord, sessionId: string): Promise<PasskeyCreationOptions>;
  /**
   * Verifies the attestation against the session's challenge, with user verification, and saves the
   * passkey; recovery codes come with it when it is the account's first factor or the account has
   * none yet. Undefined when
   * it doesn't pass.
   */
  register(account: AccountRecord, passkey: NewPasskey, sessionId: string, context: ActionContext): Promise<AddedPasskey | undefined>;
  rename(accountId: string, id: string, name: string): Passkey | undefined;
  /** Removes a passkey, unless it is the account's last factor. */
  remove(accountId: string, id: string, context: ActionContext): RemovedFactor;
  /** A challenge bound to the session, listing the account's passkeys; user verification preferred. */
  accountAssertionOptions(purpose: AccountAssertionPurpose, accountId: string, sessionId: string): Promise<PasskeyRequestOptions>;
  /** Checks an assertion by one of the account's passkeys over the session's challenge. */
  verifyAccountAssertion(
    purpose: AccountAssertionPurpose,
    accountId: string,
    sessionId: string,
    response: PasskeyAuthenticationResponse,
  ): Promise<AssertionResult>;
  /**
   * Passwordless: a challenge bound to `browserToken` (the `__Host-nu_webauthn` cookie), for any
   * discoverable passkey; user verification required.
   */
  passwordlessOptions(browserToken: string): Promise<PasskeyRequestOptions>;
  /** Finds the account by the credential id, which must match the user handle. */
  verifyPasswordless(browserToken: string, response: PasskeyAuthenticationResponse): Promise<AssertionResult>;
  /** Deletes used and void challenges. */
  sweep(): void;
}

export interface PasskeysServiceDependencies {
  readonly repository: PasskeysRepository;
  readonly relyingParty: RelyingParty;
  readonly secondFactors: Pick<SecondFactorsService, "listFactors" | "recoveryCodeStatus" | "issueFirstRecoveryCodes">;
  readonly audit: AuditService;
  readonly notices: SecurityNotices;
  readonly clock: Clock;
}

function toPasskey(row: PasskeyCredentialRow): Passkey {
  return { id: row.id, name: row.name, synced: row.backedUp, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

/** The user handle the passkey was registered with: the account's id, as UTF-8, base64url. */
const userHandleOf = (accountId: string): string => Buffer.from(accountId, "utf8").toString("base64url");

const descriptorOf = (row: PasskeyCredentialRow) => ({ credentialId: row.credentialId, transports: row.transports });

export function createPasskeysServiceWith({
  repository,
  relyingParty,
  secondFactors,
  audit,
  notices,
  clock,
}: PasskeysServiceDependencies): PasskeysService {
  const nowIso = (): string => clock.now().toISOString();

  const issueChallenge = (purpose: WebAuthnChallengePurpose, challenge: string, binding: ChallengeBinding, userId: string | null) => {
    const now = clock.now();
    repository.replaceChallenge({
      id: newId(clock),
      purpose,
      challenge,
      userId,
      binding,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_LIFETIME_MS).toISOString(),
    });
  };

  /** Checks the assertion against the stored passkey; the challenge is used up already. */
  const verifyWith = async (
    row: PasskeyCredentialRow,
    response: PasskeyAuthenticationResponse,
    challenge: string,
    userVerification: UserVerification,
  ): Promise<AssertionResult> => {
    const verified = await relyingParty.verifyAssertion(
      response,
      challenge,
      { ...descriptorOf(row), publicKey: row.publicKey },
      userVerification,
    );
    if (verified === undefined) return { passed: false, reason: "not-verified", accountId: row.userId };
    // A counter that doesn't increase means the passkey may have been cloned; authenticators that keep none send 0.
    if (!repository.usePasskey(row.id, verified.counter, verified.backedUp, nowIso())) {
      return { passed: false, reason: "counter", accountId: row.userId };
    }
    return { passed: true, accountId: row.userId };
  };

  return {
    list(accountId) {
      return repository.listPasskeys(accountId).map(toPasskey);
    },

    async registrationOptions(account, sessionId) {
      const options = await relyingParty.registrationOptions({
        accountId: account.id,
        username: account.username,
        displayName: account.displayName,
        exclude: repository.listPasskeys(account.id).map(descriptorOf),
      });
      issueChallenge("register", options.challenge, { sessionId }, account.id);
      return options;
    },

    async register(account, { name, response }, sessionId, context) {
      const challenge = repository.takeChallenge("register", { sessionId }, nowIso());
      if (challenge === undefined) return undefined;
      const verified = await relyingParty.verifyRegistration(response, challenge);
      if (verified === undefined || repository.findByCredentialId(verified.credentialId) !== undefined) return undefined;

      const needsRecoveryCodes =
        secondFactors.listFactors(account.id).length === 0 || secondFactors.recoveryCodeStatus(account.id) === null;

      const row: PasskeyCredentialRow = {
        id: newId(clock),
        userId: account.id,
        credentialId: verified.credentialId,
        publicKey: Buffer.from(verified.publicKey),
        counter: verified.counter,
        transports: verified.transports,
        backedUp: verified.backedUp,
        name: name.trim(),
        createdAt: nowIso(),
        lastUsedAt: null,
        enrolmentSessionId: sessionId,
      };
      repository.insertPasskey(row);
      audit.record({
        action: "second-factor.added",
        actor: context.actor,
        outcome: "succeeded",
        target: { kind: "second-factor", id: row.id },
        ...(context.origin === undefined ? {} : { origin: context.origin }),
        details: { kind: "passkey" },
      });
      notices.notify({ kind: "second-factor-added", accountId: account.id });
      const recoveryCodes = needsRecoveryCodes ? await secondFactors.issueFirstRecoveryCodes(account.id) : null;
      return { passkey: toPasskey(row), recoveryCodes };
    },

    rename(accountId, id, name) {
      const row = repository.findPasskey(accountId, id);
      if (row === undefined) return undefined;
      repository.renamePasskey(row.id, name.trim());
      return toPasskey({ ...row, name: name.trim() });
    },

    remove(accountId, id, context) {
      const row = repository.findPasskey(accountId, id);
      if (row === undefined) return "not-found";
      if (secondFactors.listFactors(accountId).length <= 1) return "last-factor";
      repository.deletePasskey(row.id);
      audit.record({
        action: "second-factor.removed",
        actor: context.actor,
        outcome: "succeeded",
        target: { kind: "second-factor", id: row.id },
        ...(context.origin === undefined ? {} : { origin: context.origin }),
        details: { kind: "passkey", reason: "removed-in-settings" },
      });
      notices.notify({ kind: "second-factor-removed", accountId });
      return "removed";
    },

    async accountAssertionOptions(purpose, accountId, sessionId) {
      const options = await relyingParty.authenticationOptions(repository.listPasskeys(accountId).map(descriptorOf), "preferred");
      issueChallenge(purpose, options.challenge, { sessionId }, accountId);
      return options;
    },

    async verifyAccountAssertion(purpose, accountId, sessionId, response) {
      const challenge = repository.takeChallenge(purpose, { sessionId }, nowIso());
      if (challenge === undefined) return { passed: false, reason: "invalid-challenge", accountId };
      const row = repository.findByCredentialId(response.id);
      if (row?.userId !== accountId) return { passed: false, reason: "unknown-passkey", accountId };
      return verifyWith(row, response, challenge, "preferred");
    },

    async passwordlessOptions(browserToken) {
      const options = await relyingParty.authenticationOptions([], "required");
      issueChallenge("passwordless", options.challenge, { browserTokenHash: hashToken(browserToken) }, null);
      return options;
    },

    async verifyPasswordless(browserToken, response) {
      const challenge = repository.takeChallenge("passwordless", { browserTokenHash: hashToken(browserToken) }, nowIso());
      if (challenge === undefined) return { passed: false, reason: "invalid-challenge" };
      const row = repository.findByCredentialId(response.id);
      if (row === undefined) return { passed: false, reason: "unknown-passkey" };
      if (response.response.userHandle !== userHandleOf(row.userId)) {
        return { passed: false, reason: "user-handle-mismatch", accountId: row.userId };
      }
      return verifyWith(row, response, challenge, "required");
    },

    sweep() {
      repository.deleteChallengesBefore(nowIso());
    },
  };
}
