import type { SecondFactor, SecondFactorKind, SecondFactorMethod, SecondFactors, TotpEnrolment } from "@not-unreachable/contracts";
import type { AccountRecord, PasswordHasher } from "../accounts/index.ts";
import type { AuditActor, AuditDetails, AuditOrigin, AuditService } from "../audit/index.ts";
import { MINUTE_MS, newId, type Clock, type EnvelopeAad, type Secrets } from "../platform/index.ts";
import type { SecurityNotices } from "./notices.ts";
import type { PasskeysRepository } from "./passkey-repository.ts";
import { formatRecoveryCode, newRecoveryCodes, normalizeRecoveryCode } from "./recovery-codes.ts";
import type { SecondFactorsRepository } from "./repository.ts";
import type { PasskeyCredentialRow, TotpCredentialRow } from "./schema.ts";
import { matchTotpStep, newTotpSecret, totpQrCode } from "./totp.ts";

/** An enrolment not confirmed within this time is void, and the sweep deletes it. */
export const TOTP_ENROLMENT_LIFETIME_MS = 10 * MINUTE_MS;

/** The try limits of threat model T10: past either, the pending session is revoked. */
export const secondFactorTryLimits = {
  perSession: { tries: 5, windowMs: 15 * MINUTE_MS },
  perAccount: { tries: 10, windowMs: 60 * MINUTE_MS },
} as const;

export const TOTP_ISSUER = "NotUnreachable";

/** Who acts, and from where, for the audit log. */
export interface ActionContext {
  readonly actor: AuditActor;
  readonly origin?: AuditOrigin;
}

export interface FailedTry extends ActionContext {
  readonly accountId: string;
  readonly sessionId: string;
  readonly method: SecondFactorMethod;
  readonly during: AuditDetails<"second-factor.failed">["during"];
  /** Why it failed, when the audit log should say: a passkey's counter that didn't increase. */
  readonly reason?: AuditDetails<"second-factor.failed">["reason"];
}

export interface ConfirmedEnrolment {
  readonly factor: SecondFactor;
  /** The first recovery codes, made with the account's first factor; null when it had one already. */
  readonly recoveryCodes: string[] | null;
}

export type RemovedFactor = "removed" | "not-found" | "last-factor";

export interface RemovedSecondFactors {
  readonly totp: number;
  readonly passkeys: number;
  readonly recoveryCodes: number;
}

export interface SecondFactorsService {
  /** Whether the account has a confirmed factor: an authenticator app or a passkey. */
  hasSecondFactor(accountId: string): boolean;
  /** The account's confirmed factors, authenticator apps and passkeys, oldest first; never a secret. */
  listFactors(accountId: string): SecondFactor[];
  /** How the account can pass the second step. */
  methods(accountId: string): SecondFactorMethod[];
  recoveryCodeStatus(accountId: string): SecondFactors["recoveryCodes"];
  /** Starts adding an authenticator app for the session; it counts once confirmed. */
  startTotpEnrolment(account: AccountRecord, sessionId: string): Promise<TotpEnrolment>;
  /** Confirms an enrolment the session started, if `code` is right and it is not void; undefined otherwise. */
  confirmTotpEnrolment(
    account: AccountRecord,
    enrolmentId: string,
    code: string,
    sessionId: string,
    context: ActionContext,
  ): Promise<ConfirmedEnrolment | undefined>;
  /** The kind of the account's confirmed factor enrolled in this session, if one was. */
  enrolledInSession(accountId: string, sessionId: string): SecondFactorKind | undefined;
  /** A first set of recovery codes, formatted, replacing any earlier one; `regenerateRecoveryCodes` is the audited way to renew them. */
  issueFirstRecoveryCodes(accountId: string): Promise<string[]>;
  /** Whether `code` is right for one of the account's authenticator apps; a passing step can't pass again. */
  verifyTotp(accountId: string, code: string): boolean;
  /** Uses up the recovery code if it is one of the account's unused ones; records `second-factor.recovery-code-used`. */
  useRecoveryCode(accountId: string, code: string, context: ActionContext): Promise<boolean>;
  /** Voids every earlier code and answers the new set, formatted. */
  regenerateRecoveryCodes(accountId: string, context: ActionContext): Promise<string[]>;
  /** Removes an authenticator app, unless it is the account's last factor. */
  removeTotp(accountId: string, id: string, context: ActionContext): RemovedFactor;
  /**
   * `reset-admin --second-factors`: removes every factor (authenticator apps and passkeys) and
   * recovery code, recorded as the system's,
   * and clears the account's wrong tries so the next sign-in can enrol at once.
   */
  removeAll(accountId: string): RemovedSecondFactors;
  /** Whether the session and the account are both within their try limits. */
  withinTryLimits(accountId: string, sessionId: string): boolean;
  /** Records a wrong code; answers whether it reached a limit. */
  recordFailure(failure: FailedTry): boolean;
  /** Deletes void enrolments and failures no limit counts any more. */
  sweep(): void;
}

export interface SecondFactorsServiceDependencies {
  readonly repository: SecondFactorsRepository;
  readonly passkeys: Pick<PasskeysRepository, "listPasskeys" | "deleteAllPasskeys">;
  readonly hasher: Pick<PasswordHasher, "hash" | "verify">;
  /** The master key's secrets; the CLI has none, so it can't add or check an authenticator app. */
  readonly secrets: Secrets | undefined;
  readonly audit: AuditService;
  readonly notices: SecurityNotices;
  readonly clock: Clock;
}

const totpAad = (id: string): EnvelopeAad => ({ table: "totp_credentials", column: "secret", rowId: id });

function toFactor(row: TotpCredentialRow): SecondFactor {
  return { id: row.id, kind: "totp", createdAt: row.confirmedAt ?? row.createdAt, lastUsedAt: row.lastUsedAt };
}

function passkeyToFactor(row: PasskeyCredentialRow): SecondFactor {
  return { id: row.id, kind: "passkey", createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

export function createSecondFactorsServiceWith({
  repository,
  passkeys,
  hasher,
  secrets,
  audit,
  notices,
  clock,
}: SecondFactorsServiceDependencies): SecondFactorsService {
  const requireSecrets = (): Secrets => {
    if (secrets === undefined) throw new Error("Authenticator apps need the master key");
    return secrets;
  };
  const secretOf = (row: TotpCredentialRow): string => requireSecrets().decrypt("totp", totpAad(row.id), row.secret);
  const nowIso = (): string => clock.now().toISOString();
  const since = (windowMs: number): string => new Date(clock.now().getTime() - windowMs).toISOString();

  const listFactors = (accountId: string): SecondFactor[] =>
    [...repository.listConfirmedTotp(accountId).map(toFactor), ...passkeys.listPasskeys(accountId).map(passkeyToFactor)].toSorted(
      (first, second) => first.createdAt.localeCompare(second.createdAt),
    );
  const hasSecondFactor = (accountId: string): boolean => listFactors(accountId).length > 0;

  const withinTryLimits = (accountId: string, sessionId: string): boolean => {
    const { perSession, perAccount } = secondFactorTryLimits;
    return (
      repository.countFailuresSince(accountId, since(perSession.windowMs), sessionId) < perSession.tries &&
      repository.countFailuresSince(accountId, since(perAccount.windowMs)) < perAccount.tries
    );
  };

  const storeRecoveryCodes = async (accountId: string): Promise<string[]> => {
    const codes = newRecoveryCodes();
    const batchId = newId(clock);
    const createdAt = nowIso();
    const rows = [];
    // One at a time, so a batch never fills the hasher's queue.
    for (const code of codes) {
      rows.push({ id: newId(clock), userId: accountId, batchId, codeHash: await hasher.hash(code), createdAt, usedAt: null });
    }
    repository.replaceRecoveryCodes(accountId, rows);
    return codes.map(formatRecoveryCode);
  };

  type Removal = AuditDetails<"second-factor.removed">;
  const recordRemoved = (accountId: string, kind: Removal["kind"], id: string, context: ActionContext, reason: Removal["reason"]): void => {
    audit.record({
      action: "second-factor.removed",
      actor: context.actor,
      outcome: "succeeded",
      target: { kind: kind === "recoveryCodes" ? "account" : "second-factor", id },
      ...(context.origin === undefined ? {} : { origin: context.origin }),
      details: { kind, reason },
    });
    notices.notify({ kind: "second-factor-removed", accountId });
  };

  return {
    hasSecondFactor,

    listFactors,

    methods(accountId) {
      const methods: SecondFactorMethod[] = [];
      if (repository.listConfirmedTotp(accountId).length > 0) methods.push("totp");
      if (passkeys.listPasskeys(accountId).length > 0) methods.push("passkey");
      if (repository.listUnusedRecoveryCodes(accountId).length > 0) methods.push("recoveryCode");
      return methods;
    },

    recoveryCodeStatus(accountId) {
      return repository.recoveryCodeBatch(accountId) ?? null;
    },

    async startTotpEnrolment(account, sessionId) {
      const id = newId(clock);
      const secret = newTotpSecret();
      repository.insertTotp({
        id,
        userId: account.id,
        secret: requireSecrets().encrypt("totp", totpAad(id), secret),
        lastUsedStep: null,
        createdAt: nowIso(),
        confirmedAt: null,
        lastUsedAt: null,
        enrolmentSessionId: sessionId,
      });
      return { id, setupKey: secret, qrCode: await totpQrCode(secret, account.username, TOTP_ISSUER) };
    },

    async confirmTotpEnrolment(account, enrolmentId, code, sessionId, context) {
      const row = repository.findTotp(account.id, enrolmentId);
      const now = clock.now();
      const pending =
        row !== undefined &&
        row.confirmedAt === null &&
        row.enrolmentSessionId === sessionId &&
        now.getTime() - Date.parse(row.createdAt) < TOTP_ENROLMENT_LIFETIME_MS;
      if (!pending) return undefined;
      const step = matchTotpStep(secretOf(row), code, now, null);
      if (step === undefined) return undefined;

      const first = !hasSecondFactor(account.id);
      const at = now.toISOString();
      repository.confirmTotp(row.id, step, at);
      audit.record({
        action: "second-factor.added",
        actor: context.actor,
        outcome: "succeeded",
        target: { kind: "second-factor", id: row.id },
        ...(context.origin === undefined ? {} : { origin: context.origin }),
        details: { kind: "totp" },
      });
      notices.notify({ kind: "second-factor-added", accountId: account.id });
      const recoveryCodes = first ? await storeRecoveryCodes(account.id) : null;
      return { factor: toFactor({ ...row, confirmedAt: at, lastUsedStep: step, lastUsedAt: at }), recoveryCodes };
    },

    enrolledInSession(accountId, sessionId) {
      if (repository.listConfirmedTotp(accountId).some((row) => row.enrolmentSessionId === sessionId)) return "totp";
      if (passkeys.listPasskeys(accountId).some((row) => row.enrolmentSessionId === sessionId)) return "passkey";
      return undefined;
    },

    issueFirstRecoveryCodes: storeRecoveryCodes,

    verifyTotp(accountId, code) {
      const now = clock.now();
      // Every app is checked, so the time doesn't tell which one a code belongs to.
      const matches = repository
        .listConfirmedTotp(accountId)
        .map((row) => ({ row, step: matchTotpStep(secretOf(row), code, now, row.lastUsedStep) }));
      const match = matches.find((candidate) => candidate.step !== undefined);
      if (match?.step === undefined) return false;
      return repository.useTotpStep(match.row.id, match.step, now.toISOString());
    },

    async useRecoveryCode(accountId, typed, context) {
      const code = normalizeRecoveryCode(typed);
      if (code === undefined) return false;
      for (const row of repository.listUnusedRecoveryCodes(accountId)) {
        if (!(await hasher.verify(row.codeHash, code))) continue;
        if (!repository.useRecoveryCode(row.id, nowIso())) return false;
        const remaining = repository.listUnusedRecoveryCodes(accountId).length;
        audit.record({
          action: "second-factor.recovery-code-used",
          actor: context.actor,
          outcome: "succeeded",
          target: { kind: "account", id: accountId },
          ...(context.origin === undefined ? {} : { origin: context.origin }),
          details: { remaining },
        });
        notices.notify({ kind: "recovery-code-used", accountId, remaining });
        return true;
      }
      return false;
    },

    async regenerateRecoveryCodes(accountId, context) {
      const codes = await storeRecoveryCodes(accountId);
      audit.record({
        action: "recovery-codes.regenerated",
        actor: context.actor,
        outcome: "succeeded",
        target: { kind: "account", id: accountId },
        ...(context.origin === undefined ? {} : { origin: context.origin }),
        details: { count: codes.length },
      });
      return codes;
    },

    removeTotp(accountId, id, context) {
      const row = repository.findTotp(accountId, id);
      if (row?.confirmedAt == null) return "not-found";
      if (listFactors(accountId).length <= 1) return "last-factor";
      repository.deleteTotp(row.id);
      recordRemoved(accountId, "totp", row.id, context, "removed-in-settings");
      return "removed";
    },

    removeAll(accountId) {
      const system: ActionContext = { actor: { kind: "system" } };
      const factors = repository.listConfirmedTotp(accountId);
      const passkeyRows = passkeys.listPasskeys(accountId);
      const totp = repository.deleteAllTotp(accountId);
      const passkeyCount = passkeys.deleteAllPasskeys(accountId);
      const recoveryCodes = repository.deleteAllRecoveryCodes(accountId);
      // Wrong codes for the removed factors would otherwise hold the account's try limit and refuse the new enrolment.
      repository.deleteAllFailures(accountId);
      for (const factor of factors) recordRemoved(accountId, "totp", factor.id, system, "reset-admin");
      for (const passkey of passkeyRows) recordRemoved(accountId, "passkey", passkey.id, system, "reset-admin");
      if (recoveryCodes > 0) recordRemoved(accountId, "recoveryCodes", accountId, system, "reset-admin");
      return { totp, passkeys: passkeyCount, recoveryCodes };
    },

    withinTryLimits,

    recordFailure({ accountId, sessionId, method, during, reason, actor, origin }) {
      repository.insertFailure({ id: newId(clock), userId: accountId, sessionId, at: nowIso() });
      const limitReached = !withinTryLimits(accountId, sessionId);
      audit.record({
        action: "second-factor.failed",
        actor,
        outcome: "failed",
        target: { kind: "account", id: accountId },
        ...(origin === undefined ? {} : { origin }),
        details: { method, during, limitReached, ...(reason === undefined ? {} : { reason }) },
      });
      if (limitReached) notices.notify({ kind: "second-factor-locked", accountId });
      return limitReached;
    },

    sweep() {
      repository.deleteUnconfirmedTotpCreatedBefore(since(TOTP_ENROLMENT_LIFETIME_MS));
      repository.deleteFailuresBefore(since(secondFactorTryLimits.perAccount.windowMs));
    },
  };
}
