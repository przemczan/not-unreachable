import {
  problemTypes,
  relinkPath,
  RELINK_LINK_LIFETIME_DAYS,
  type changeUserRequestSchema,
  type CreatedRelinkLink,
  type DefaultQuota,
  type HomeFolderChoice,
  type User,
  type Users,
} from "@not-unreachable/contracts";
import type { z } from "zod";
import { HttpProblem } from "../../http/index.ts";
import type { AccountRecord, AccountsService } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import type { MailService } from "../mail/index.ts";
import type { Clock, Logger } from "../platform/index.ts";
import { ResourceUnavailableError, type HomePlace, type ResourcesService } from "../resources/index.ts";
import type { SessionsService } from "../sessions/index.ts";
import type { SettingsService } from "../settings/index.ts";
import type { LinkedSignInsService } from "../sso/index.ts";
import { PathRefusedError } from "../storage/index.ts";
import { emailLink, type AdminContext, type LinkTokens } from "./links.ts";
import type { InvitationsRepository } from "./repository.ts";

export type UserChange = z.output<typeof changeUserRequestSchema>;

/**
 * The admin's Users tab. Its use cases span accounts, sessions, linked sign-ins, homes and re-link
 * links, so they live here, above all of them. Every route answers 404 for the admin's own account
 * and for any id that isn't a user's.
 */
export interface UsersService {
  list(): Users;
  get(id: string): User;
  /** Disabling revokes every session of the user; records `account.disabled`, `.enabled` or `.changed`. */
  change(id: string, change: UserChange, context: AdminContext): User;
  /** Signs the user out everywhere and removes the account; the home is kept (its name reserved) or deleted first. */
  remove(id: string, homeFolder: HomeFolderChoice, context: AdminContext): Promise<void>;
  /** 409 `last-sign-in-method` for the user's last one. */
  unlink(id: string, linkId: string, context: AdminContext): void;
  /** A new re-link link, valid a day; the user's earlier pending ones are revoked. */
  createRelinkLink(id: string, context: AdminContext): Promise<CreatedRelinkLink>;
  setDefaultQuota(defaultQuotaBytes: number, context: AdminContext): DefaultQuota;
}

export interface UsersServiceDependencies {
  readonly repository: InvitationsRepository;
  readonly links: LinkTokens;
  readonly accounts: Pick<AccountsService, "findById" | "listUsers" | "setStatus" | "setQuota" | "deleteAccount">;
  readonly sessions: Pick<SessionsService, "revokeAll">;
  readonly linkedSignIns: Pick<LinkedSignInsService, "list" | "unlink" | "removeAll">;
  readonly resources: Pick<ResourcesService, "homePlace" | "homePlaces" | "homeExists" | "removeHome" | "forgetHome">;
  readonly settings: SettingsService;
  readonly mail: Pick<MailService, "isConfigured" | "send">;
  readonly audit: AuditService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publicOrigin: string;
}

const notFound = (): HttpProblem => new HttpProblem(404, problemTypes.notFound);

/** A failure to delete the home, as the admin's answer: the user stays. */
function homeProblem(error: unknown): unknown {
  if (error instanceof ResourceUnavailableError) {
    return new HttpProblem(409, problemTypes.resourceUnavailable, "The home folder's resource is unavailable, so the user was kept.");
  }
  if (error instanceof PathRefusedError) return new HttpProblem(422, problemTypes.pathRefused, "The home folder could not be deleted.");
  return error;
}

export function createUsersService({
  repository,
  links,
  accounts,
  sessions,
  linkedSignIns,
  resources,
  settings,
  mail,
  audit,
  clock,
  logger,
  publicOrigin,
}: UsersServiceDependencies): UsersService {
  const findUser = (id: string): AccountRecord => {
    const account = accounts.findById(id);
    if (account?.role !== "user") throw notFound();
    return account;
  };

  const toUser = (account: AccountRecord, home: HomePlace | undefined): User => ({
    id: account.id,
    username: account.username,
    email: account.email,
    displayName: account.displayName,
    status: account.status,
    quotaBytes: account.quotaBytes,
    linkedSignIns: linkedSignIns.list({ id: account.id, role: "user" }).map((link) => ({
      id: link.id,
      providerId: link.providerId,
      providerName: link.providerName,
      providerKind: link.providerKind,
      email: link.email,
      createdAt: link.createdAt,
      lastUsedAt: link.lastUsedAt,
    })),
    home: home === undefined ? null : { resourceId: home.resourceId, path: home.path },
    createdAt: account.createdAt,
    disabledAt: account.disabledAt,
  });

  const userOf = (account: AccountRecord): User => toUser(account, resources.homePlace(account.username));

  const changeStatus = (account: AccountRecord, status: AccountRecord["status"], context: AdminContext): void => {
    if (status === account.status) return;
    const target = { kind: "account", id: account.id };
    if (status === "disabled") {
      // Before disabling: a disabled account's sessions no longer count as live.
      const revokedSessions = sessions.revokeAll(account.id, "account-disabled", context);
      accounts.setStatus(account.id, "disabled");
      audit.record({ action: "account.disabled", ...context, outcome: "succeeded", target, details: { revokedSessions } });
      return;
    }
    accounts.setStatus(account.id, "active");
    audit.record({ action: "account.enabled", ...context, outcome: "succeeded", target, details: {} });
  };

  const changeQuota = (account: AccountRecord, quotaBytes: number | null, context: AdminContext): void => {
    if (quotaBytes === account.quotaBytes) return;
    accounts.setQuota(account.id, quotaBytes);
    audit.record({
      action: "account.changed",
      ...context,
      outcome: "succeeded",
      target: { kind: "account", id: account.id },
      details: { fields: ["quota"] },
    });
  };

  /** Keeping the home reserves its name while the folder is there; a home gone from disk is only forgotten. */
  const settleHome = async (username: string, homeFolder: HomeFolderChoice): Promise<boolean> => {
    if (homeFolder === "delete") {
      try {
        await resources.removeHome(username);
      } catch (error) {
        throw homeProblem(error);
      }
      return false;
    }
    return resources.homeExists(username);
  };

  return {
    list() {
      const homes = resources.homePlaces();
      return {
        users: accounts.listUsers().map((account) => toUser(account, homes.get(account.username))),
        defaultQuotaBytes: settings.get("defaultQuotaBytes"),
      };
    },

    get: (id) => userOf(findUser(id)),

    change(id, change, context) {
      const account = findUser(id);
      if (change.status !== undefined) changeStatus(account, change.status, context);
      if (change.quotaBytes !== undefined) changeQuota(account, change.quotaBytes, context);
      return userOf(findUser(id));
    },

    async remove(id, homeFolder, context) {
      const account = findUser(id);
      const reserve = await settleHome(account.username, homeFolder);
      repository.transaction(() => {
        sessions.revokeAll(account.id, "account-removed", context);
        linkedSignIns.removeAll(account.id, context);
        repository.revokePendingRelinks(account.id, clock.now().toISOString());
        if (reserve) repository.reserve(account.username, clock.now().toISOString());
        else resources.forgetHome(account.username);
        accounts.deleteAccount(account.id);
        audit.record({
          action: "account.deleted",
          ...context,
          outcome: "succeeded",
          target: { kind: "account", id: account.id },
          details: { username: account.username, homeFolder },
        });
      });
    },

    unlink(id, linkId, context) {
      const account = findUser(id);
      const unlinked = linkedSignIns.unlink({ id: account.id, role: "user" }, linkId, context);
      if (unlinked === "not-found") throw notFound();
      if (unlinked === "last-sign-in-method") {
        throw new HttpProblem(409, problemTypes.lastSignInMethod, "This is the user's only way to sign in: send a re-link link instead.");
      }
    },

    async createRelinkLink(id, context) {
      const account = findUser(id);
      const revokedEarlier = repository.revokePendingRelinks(account.id, clock.now().toISOString());
      const { row, token } = links.issue({
        kind: "relink",
        email: null,
        sendByEmail: false,
        verifyEmail: false,
        targetUserId: account.id,
        createdBy: context.actor.kind === "account" ? context.actor.accountId : null,
        lifetimeDays: RELINK_LINK_LIFETIME_DAYS,
      });
      const template = { kind: "relink", token, expiresAt: row.expiresAt, username: account.username } as const;
      const emailed = await emailLink({ mail, logger }, template, account.email);
      audit.record({
        action: "relink.created",
        ...context,
        outcome: "succeeded",
        target: { kind: "account", id: account.id },
        details: { relinkId: row.id, expiresAt: row.expiresAt, emailed, revokedEarlier },
      });
      return { link: new URL(relinkPath(token), publicOrigin).href, expiresAt: row.expiresAt, emailed };
    },

    setDefaultQuota(defaultQuotaBytes, context) {
      const updatedBy = context.actor.kind === "account" ? context.actor.accountId : null;
      const stored = settings.set("defaultQuotaBytes", defaultQuotaBytes, updatedBy);
      audit.record({ action: "settings.changed", ...context, outcome: "succeeded", details: { keys: ["defaultQuotaBytes"] } });
      return { defaultQuotaBytes: stored };
    },
  };
}
