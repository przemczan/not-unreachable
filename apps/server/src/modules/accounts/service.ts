import { problemTypes, usernameSchema, type Account, type Role } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import type { AuditActor, AuditOrigin, AuditService } from "../audit/index.ts";
import { newId, type Clock, type Logger } from "../platform/index.ts";
import type { PasswordHasher } from "./password-hasher.ts";
import { assertAcceptablePassword } from "./password-rules.ts";
import type { AccountsRepository } from "./repository.ts";
import type { UserRow } from "./schema.ts";

export type AccountStatus = UserRow["status"];

/** An account as other modules see it; never its credentials. */
export interface AccountRecord {
  readonly id: string;
  readonly username: string;
  /** Lowercase; always set for the admin, optional for a user. */
  readonly email: string | null;
  readonly displayName: string;
  readonly role: Role;
  readonly status: AccountStatus;
  /** The most bytes the home may hold; null takes the `defaultQuotaBytes` setting. */
  readonly quotaBytes: number | null;
  readonly createdAt: string;
  readonly disabledAt: string | null;
}

export interface NewAccount {
  readonly username: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly role: Role;
}

/** The outcome of a password check; `no-password` took as long as the others. */
export type PasswordCheck = "ok" | "wrong-password" | "no-password";

export type ProfileField = "email" | "displayName";

export interface ProfileChange {
  readonly email?: string | undefined;
  readonly displayName?: string | undefined;
}

export interface ProfileChangeContext {
  readonly actor: AuditActor;
  readonly origin: AuditOrigin;
  /** Whether the caller has a recent sign-in, which an email change needs (threat model, T1). */
  readonly recentSignIn: boolean;
}

/** How many accounts of role `user` are active and disabled. */
export interface UserCounts {
  readonly active: number;
  readonly disabled: number;
}

export interface AccountsService {
  findById(id: string): AccountRecord | undefined;
  /** By username or email, in any case: usernames and stored emails are lowercase. */
  findByIdentifier(identifier: string): AccountRecord | undefined;
  findAdmin(): AccountRecord | undefined;
  /** An active account with no sign-in method yet; the database refuses a taken username or email and a second admin. */
  create(account: NewAccount): AccountRecord;
  /** The accounts of role `user`, oldest first; never the admin. */
  listUsers(): AccountRecord[];
  /** The accounts of role `user` by status, in one aggregate query; never the admin. */
  countUsers(): UserCounts;
  isUsernameTaken(username: string): boolean;
  /** Whether an account has this email, in any case. */
  isEmailTaken(email: string): boolean;
  /** Disabling stamps `disabled_at`, enabling clears it. It revokes nothing: the caller revokes the sessions. */
  setStatus(accountId: string, status: AccountStatus): void;
  setQuota(accountId: string, quotaBytes: number | null): void;
  /** Deletes the account; the database deletes its credentials, sessions and links with it. Answers whether there was one. */
  deleteAccount(accountId: string): boolean;
  /**
   * Verifies the password of `account`. With no account, or one without a password, it verifies a
   * dummy hash instead, so every case takes the same time (threat model, T1). After a success, it
   * upgrades a hash made with older parameters. Throws `PasswordHashingBusyError` (503).
   */
  checkPassword(account: AccountRecord | undefined, password: string): Promise<PasswordCheck>;
  /** Checks the password rules (422), then hashes and stores it as the account's password. */
  setPassword(accountId: string, password: string): Promise<void>;
  /** Removes the account's password credential; answers whether it had one. */
  deletePassword(accountId: string): boolean;
  /** Changes the email or display name and records `account.changed` (403 `recentSignInRequired` for an email without a recent sign-in). */
  updateProfile(accountId: string, change: ProfileChange, context: ProfileChangeContext): AccountRecord;
}

export interface AccountsServiceDependencies {
  readonly repository: AccountsRepository;
  readonly hasher: PasswordHasher;
  readonly audit: AuditService;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function toAccountRecord(row: UserRow): AccountRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    quotaBytes: row.quotaBytes,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
  };
}

/** The account as the API shows it. */
export function toAccount(record: AccountRecord): Account {
  return { id: record.id, username: record.username, email: record.email, displayName: record.displayName, role: record.role };
}

function changedFields(current: AccountRecord, change: ProfileChange): ProfileField[] {
  const fields: ProfileField[] = [];
  if (change.email !== undefined && change.email.toLowerCase() !== current.email) fields.push("email");
  if (change.displayName !== undefined && change.displayName !== current.displayName) fields.push("displayName");
  return fields;
}

/** A sign-in identifier (username or email) as the lookup compares it: trimmed and lower-case. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

export function createAccountsServiceWith({ repository, hasher, audit, clock, logger }: AccountsServiceDependencies): AccountsService {
  const findById = (id: string): AccountRecord | undefined => {
    const row = repository.findUserById(id);
    return row === undefined ? undefined : toAccountRecord(row);
  };

  const upgradeHash = async (accountId: string, password: string): Promise<void> => {
    try {
      repository.savePasswordHash(accountId, await hasher.hash(password), clock.now().toISOString());
    } catch (error) {
      // The sign-in already succeeded; the next one tries again.
      logger.warn({ err: error, accountId }, "Could not upgrade the password hash");
    }
  };

  return {
    findById,

    findByIdentifier(identifier) {
      const key = normalizeIdentifier(identifier);
      const row = key.includes("@") ? repository.findUserByEmail(key) : repository.findUserByUsername(key);
      return row === undefined ? undefined : toAccountRecord(row);
    },

    findAdmin() {
      const row = repository.findAdmin();
      return row === undefined ? undefined : toAccountRecord(row);
    },

    create(account) {
      const row: UserRow = {
        id: newId(clock),
        username: usernameSchema.parse(account.username),
        email: account.email?.toLowerCase() ?? null,
        displayName: account.displayName,
        role: account.role,
        status: "active",
        quotaBytes: null,
        createdAt: clock.now().toISOString(),
        disabledAt: null,
      };
      repository.insertUser(row);
      return toAccountRecord(row);
    },

    listUsers: () => repository.listUsers().map(toAccountRecord),

    countUsers: () => repository.countUsers(),

    isUsernameTaken: (username) => repository.findUserByUsername(username) !== undefined,

    isEmailTaken: (email) => repository.findUserByEmail(normalizeIdentifier(email)) !== undefined,

    setStatus(accountId, status) {
      repository.updateUser(accountId, { status, disabledAt: status === "disabled" ? clock.now().toISOString() : null });
    },

    setQuota(accountId, quotaBytes) {
      repository.updateUser(accountId, { quotaBytes });
    },

    deleteAccount: (accountId) => repository.deleteUser(accountId),

    async checkPassword(account, password) {
      const stored = account === undefined ? undefined : repository.findPasswordHash(account.id);
      if (account === undefined || stored === undefined) {
        await hasher.verifyDummy(password);
        return "no-password";
      }
      if (!(await hasher.verify(stored, password))) return "wrong-password";
      if (hasher.needsRehash(stored)) await upgradeHash(account.id, password);
      return "ok";
    },

    async setPassword(accountId, password) {
      assertAcceptablePassword(password);
      const hash = await hasher.hash(password);
      repository.savePasswordHash(accountId, hash, clock.now().toISOString());
    },

    deletePassword(accountId) {
      return repository.deletePasswordCredential(accountId);
    },

    updateProfile(accountId, change, context) {
      const current = findById(accountId);
      if (current === undefined) throw new HttpProblem(404, problemTypes.notFound);
      const fields = changedFields(current, change);
      if (fields.length === 0) return current;
      if (fields.includes("email") && !context.recentSignIn) {
        throw new HttpProblem(403, problemTypes.recentSignInRequired, "Confirm your password to change your email.");
      }
      const email = fields.includes("email") ? change.email?.toLowerCase() : undefined;
      if (email !== undefined && repository.findUserByEmail(email) !== undefined) {
        throw new HttpProblem(422, problemTypes.validationFailed, "Another account uses this email.");
      }
      repository.updateUser(accountId, {
        ...(email === undefined ? {} : { email }),
        ...(fields.includes("displayName") && change.displayName !== undefined ? { displayName: change.displayName } : {}),
      });
      audit.record({
        action: "account.changed",
        actor: context.actor,
        outcome: "succeeded",
        target: { kind: "account", id: accountId },
        origin: context.origin,
        details: { fields },
      });
      return findById(accountId) ?? current;
    },
  };
}
