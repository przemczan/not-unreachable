import type { SessionState } from "@not-unreachable/contracts";
import type { AccountRecord, AccountsService } from "../accounts/index.ts";
import { USER_AGENT_MAX_CHARACTERS, type AuditActor, type AuditDetails, type AuditOrigin, type AuditService } from "../audit/index.ts";
import { hashToken, newId, newToken, type Clock } from "../platform/index.ts";
import type { SettingsService } from "../settings/index.ts";
import type { SessionsRepository } from "./repository.ts";
import type { SessionRow } from "./schema.ts";
import { isSessionLive, shouldTouch } from "./timeouts.ts";

export type RevokeReason = AuditDetails<"session.revoked">["reason"];

/** How a session's first step was passed: the admin's password, or an SSO provider. */
export type SignInMethod = SessionRow["signInMethod"];

/** A session that is neither revoked nor timed out, with its account. */
export interface LiveSession {
  readonly id: string;
  readonly account: AccountRecord;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly recentSignInAt: string | null;
  readonly signInMethod: SignInMethod;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface StartedSession {
  readonly session: LiveSession;
  /** For the cookie only; the database holds its SHA-256. */
  readonly token: string;
}

export interface NewSession {
  readonly account: AccountRecord;
  readonly state: SessionState;
  /** Whether the session starts with a proof of the password or a factor, which counts as a recent sign-in. */
  readonly recentSignIn: boolean;
  /** `password` when left out. */
  readonly method?: SignInMethod;
  readonly origin: AuditOrigin;
}

/** Who revokes sessions, for the `session.revoked` events. */
export interface RevokeContext {
  readonly actor: AuditActor;
  readonly origin?: AuditOrigin;
}

export interface SessionsService {
  start(session: NewSession): StartedSession;
  /** The live session a cookie token belongs to; writes `last_seen_at` at most once a minute. */
  resolve(token: string): LiveSession | undefined;
  /** The session by its id while it is live, in either state; it touches nothing. */
  findLive(sessionId: string): LiveSession | undefined;
  /**
   * Gives the session a new token (threat model, T2), so the old one no longer resolves; with
   * `renewRecentSignIn`, its recent sign-in starts again now. Answers the new token.
   */
  rotate(sessionId: string, options: { readonly renewRecentSignIn: boolean }): string;
  /**
   * Makes a session pending its second factor active once a factor passes: a new token and a
   * recent sign-in that starts now (threat model, T2 and T10). Answers the new token.
   */
  activate(sessionId: string): string;
  /** The account's live sessions, oldest first. */
  listLive(accountId: string): LiveSession[];
  /** Ends a session at sign-out; it records nothing, as the caller records `sign-out`. */
  end(sessionId: string): boolean;
  /** Revokes one live session of the account and records `session.revoked`; false when it has none by that id. */
  revoke(accountId: string, sessionId: string, reason: RevokeReason, context: RevokeContext): boolean;
  /** Revokes every session of the account but one, recording `session.revoked` for each live one; answers how many. */
  revokeOthers(accountId: string, keepSessionId: string, reason: RevokeReason, context: RevokeContext): number;
  /**
   * Revokes every session of the account (`reset-admin`, disabling, removing or re-linking a user),
   * recording `session.revoked` for each live one; answers how many. Call it before disabling: a
   * disabled account's sessions are no longer live, so none would be counted.
   */
  revokeAll(accountId: string, reason: RevokeReason, context: RevokeContext): number;
}

export interface SessionsServiceDependencies {
  readonly repository: SessionsRepository;
  readonly accounts: Pick<AccountsService, "findById">;
  readonly settings: SettingsService;
  readonly audit: AuditService;
  readonly clock: Clock;
}

const toState = (state: SessionRow["state"]): SessionState => (state === "active" ? "active" : "pendingSecondFactor");
const toStoredState = (state: SessionState): SessionRow["state"] => (state === "active" ? "active" : "pending_second_factor");

function firstCharacters(text: string | null, count: number): string | null {
  return text === null ? null : Array.from(text).slice(0, count).join("");
}

function toLiveSession(row: SessionRow, account: AccountRecord): LiveSession {
  return {
    id: row.id,
    account,
    state: toState(row.state),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    recentSignInAt: row.recentSignInAt,
    signInMethod: row.signInMethod,
    ip: row.ip,
    userAgent: row.userAgent,
  };
}

export function createSessionsServiceWith({ repository, accounts, settings, audit, clock }: SessionsServiceDependencies): SessionsService {
  const live = (row: SessionRow, account: AccountRecord): boolean =>
    account.status === "active" && isSessionLive(row, account.role, settings.get("sessionTimeouts"), clock.now());

  const recordRevoked = (row: SessionRow, reason: RevokeReason, context: RevokeContext): void => {
    audit.record({
      action: "session.revoked",
      actor: context.actor,
      outcome: "succeeded",
      target: { kind: "session", id: row.id },
      ...(context.origin === undefined ? {} : { origin: context.origin }),
      details: { sessionId: row.id, reason },
    });
  };

  /** Revokes the account's unrevoked sessions that `which` picks; records and counts the live ones. */
  const revokeWhere = (accountId: string, which: (row: SessionRow) => boolean, reason: RevokeReason, context: RevokeContext): number => {
    const account = accounts.findById(accountId);
    if (account === undefined) return 0;
    const at = clock.now().toISOString();
    let count = 0;
    for (const row of repository.listUnrevoked(accountId).filter(which)) {
      const wasLive = live(row, account);
      if (repository.revoke(row.id, at) && wasLive) {
        recordRevoked(row, reason, context);
        count += 1;
      }
    }
    return count;
  };

  return {
    start({ account, state, recentSignIn, method, origin }) {
      const now = clock.now().toISOString();
      const token = newToken();
      const row: SessionRow = {
        id: newId(clock),
        tokenHash: hashToken(token),
        userId: account.id,
        state: toStoredState(state),
        createdAt: now,
        lastSeenAt: now,
        recentSignInAt: recentSignIn ? now : null,
        signInMethod: method ?? "password",
        ip: origin.ip,
        userAgent: firstCharacters(origin.userAgent, USER_AGENT_MAX_CHARACTERS),
        revokedAt: null,
      };
      repository.insert(row);
      return { session: toLiveSession(row, account), token };
    },

    resolve(token) {
      const row = repository.findByTokenHash(hashToken(token));
      if (row === undefined) return undefined;
      const account = accounts.findById(row.userId);
      if (account === undefined || !live(row, account)) return undefined;
      const now = clock.now();
      if (!shouldTouch(row.lastSeenAt, now)) return toLiveSession(row, account);
      const lastSeenAt = now.toISOString();
      repository.update(row.id, { lastSeenAt });
      return toLiveSession({ ...row, lastSeenAt }, account);
    },

    findLive(sessionId) {
      const row = repository.findById(sessionId);
      if (row === undefined) return undefined;
      const account = accounts.findById(row.userId);
      return account !== undefined && live(row, account) ? toLiveSession(row, account) : undefined;
    },

    rotate(sessionId, { renewRecentSignIn }) {
      const token = newToken();
      repository.update(sessionId, {
        tokenHash: hashToken(token),
        ...(renewRecentSignIn ? { recentSignInAt: clock.now().toISOString() } : {}),
      });
      return token;
    },

    activate(sessionId) {
      const token = newToken();
      repository.update(sessionId, {
        tokenHash: hashToken(token),
        state: toStoredState("active"),
        recentSignInAt: clock.now().toISOString(),
      });
      return token;
    },

    listLive(accountId) {
      const account = accounts.findById(accountId);
      if (account === undefined) return [];
      return repository
        .listUnrevoked(accountId)
        .filter((row) => live(row, account))
        .map((row) => toLiveSession(row, account));
    },

    end(sessionId) {
      return repository.revoke(sessionId, clock.now().toISOString());
    },

    revoke(accountId, sessionId, reason, context) {
      const row = repository.findById(sessionId);
      const account = accounts.findById(accountId);
      if (row === undefined || account === undefined || row.userId !== accountId || !live(row, account)) return false;
      if (!repository.revoke(row.id, clock.now().toISOString())) return false;
      recordRevoked(row, reason, context);
      return true;
    },

    revokeOthers(accountId, keepSessionId, reason, context) {
      return revokeWhere(accountId, (row) => row.id !== keepSessionId, reason, context);
    },

    revokeAll(accountId, reason, context) {
      return revokeWhere(accountId, () => true, reason, context);
    },
  };
}
