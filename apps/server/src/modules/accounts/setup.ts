import { problemTypes, type SetupRequest, type SetupStatus } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import type { AuditOrigin, AuditService } from "../audit/index.ts";
import { hashToken, newId, newToken, type Clock } from "../platform/index.ts";
import type { PasswordHasher } from "./password-hasher.ts";
import { assertAcceptablePassword } from "./password-rules.ts";
import type { AccountsRepository } from "./repository.ts";
import type { SetupTokenRow, UserRow } from "./schema.ts";

export const SETUP_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export type SetupPurpose = SetupTokenRow["purpose"];

/** A setup token just issued: the only time the token itself exists outside the link. */
export interface IssuedSetupToken {
  readonly purpose: SetupPurpose;
  readonly token: string;
  readonly expiresAt: string;
}

/** `setup-link` once an admin exists. */
export class AdminExistsError extends Error {
  override readonly name = "AdminExistsError";

  constructor() {
    super("An admin already exists. To give the admin a new password, use reset-admin.");
  }
}

/** `reset-admin` before any admin exists. */
export class NoAdminError extends Error {
  override readonly name = "NoAdminError";

  constructor() {
    super("No admin exists yet. To create one, use setup-link.");
  }
}

export interface SetupService {
  status(): SetupStatus;
  /**
   * A `first-run` token, replacing any earlier unused one; records `setup-link.issued`.
   * Throws {@link AdminExistsError}.
   */
  issueFirstRunToken(): IssuedSetupToken;
  /**
   * An `admin-reset` token for the admin, replacing any earlier unused one; records
   * `setup-link.issued`. Throws {@link NoAdminError}.
   */
  issueAdminResetToken(): IssuedSetupToken;
  /**
   * First run: creates the admin with its password. After `reset-admin`: sets the admin's new
   * password. Anything else (an unknown, expired or used token, or one or a body for the other
   * state) is the same 404; a password that breaks the rules is a 422 and keeps the token.
   */
  complete(request: SetupRequest, origin: AuditOrigin): Promise<{ readonly username: string }>;
}

export interface SetupServiceDependencies {
  readonly repository: AccountsRepository;
  readonly hasher: PasswordHasher;
  readonly audit: AuditService;
  readonly clock: Clock;
}

const notFound = (): HttpProblem => new HttpProblem(404, problemTypes.notFound);

type FirstRun = Extract<SetupRequest, { username: string }>;

function isFirstRun(request: SetupRequest): request is FirstRun {
  return "username" in request;
}

export function createSetupServiceWith({ repository, hasher, audit, clock }: SetupServiceDependencies): SetupService {
  const issue = (purpose: SetupPurpose, userId: string | null): IssuedSetupToken => {
    const now = clock.now();
    const token = newToken();
    const expiresAt = new Date(now.getTime() + SETUP_TOKEN_LIFETIME_MS).toISOString();
    repository.replaceSetupToken({
      id: newId(clock),
      purpose,
      tokenHash: hashToken(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt,
      usedAt: null,
    });
    audit.record({ action: "setup-link.issued", actor: { kind: "system" }, outcome: "succeeded", details: { purpose, expiresAt } });
    return { purpose, token, expiresAt };
  };

  /** The token row when it is valid for the instance's state and the body's shape; otherwise undefined. */
  const usableToken = (request: SetupRequest, admin: UserRow | undefined): SetupTokenRow | undefined => {
    const row = repository.findSetupTokenByHash(hashToken(request.token));
    if (row === undefined || row.usedAt !== null || clock.now().toISOString() >= row.expiresAt) return undefined;
    if (admin === undefined) return row.purpose === "first-run" && isFirstRun(request) ? row : undefined;
    return row.purpose === "admin-reset" && !isFirstRun(request) && row.userId === admin.id ? row : undefined;
  };

  const createAdmin = (request: FirstRun, hash: string, at: string): UserRow => {
    const admin: UserRow = {
      id: newId(clock),
      username: request.username,
      email: request.email.toLowerCase(),
      displayName: request.displayName,
      role: "admin",
      status: "active",
      quotaBytes: null,
      createdAt: at,
      disabledAt: null,
    };
    repository.insertUser(admin);
    repository.savePasswordHash(admin.id, hash, at);
    return admin;
  };

  return {
    status: () => ({ adminExists: repository.findAdmin() !== undefined }),

    issueFirstRunToken() {
      if (repository.findAdmin() !== undefined) throw new AdminExistsError();
      return issue("first-run", null);
    },

    issueAdminResetToken() {
      const admin = repository.findAdmin();
      if (admin === undefined) throw new NoAdminError();
      return issue("admin-reset", admin.id);
    },

    async complete(request, origin) {
      if (usableToken(request, repository.findAdmin()) === undefined) throw notFound();
      assertAcceptablePassword(request.password);
      const hash = await hasher.hash(request.password);

      // Checked again inside the transaction: another request may have used the token while this one hashed.
      const admin = repository.transaction(() => {
        const current = repository.findAdmin();
        const token = usableToken(request, current);
        const at = clock.now().toISOString();
        if (token === undefined || !repository.markSetupTokenUsed(token.id, at)) return undefined;
        if (current === undefined) return isFirstRun(request) ? createAdmin(request, hash, at) : undefined;
        repository.savePasswordHash(current.id, hash, at);
        return current;
      });
      if (admin === undefined) throw notFound();

      audit.record({
        action: "setup.completed",
        actor: { kind: "account", accountId: admin.id, username: admin.username },
        outcome: "succeeded",
        target: { kind: "account", id: admin.id },
        origin,
        details: { purpose: isFirstRun(request) ? "first-run" : "admin-reset" },
      });
      return { username: admin.username };
    },
  };
}
