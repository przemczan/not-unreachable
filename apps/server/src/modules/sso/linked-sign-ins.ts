import { LINKED_SIGN_INS_PATH, type LinkedSignIn, type LinkFailure, type Role, type SessionState } from "@not-unreachable/contracts";
import type { AuditService } from "../audit/index.ts";
import { newId, type Clock } from "../platform/index.ts";
import type { SsoPurpose, SsoRedirect } from "./flows.ts";
import type { ActionContext, SsoProviderRecord } from "./providers.ts";
import type { SsoRepository } from "./repository.ts";
import type { LinkedSignInRow } from "./schema.ts";

export const LINK_PURPOSE = "link";

/** The account a linked sign-in signs in as. */
export interface LinkedIdentity {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
}

export interface LinkingAccount {
  readonly id: string;
  readonly role: Role;
}

export type Unlinked = "removed" | "not-found" | "last-sign-in-method";

/** An identity checked at a callback, to link to an account (an invitation's or a re-link's). */
export interface NewLink {
  readonly accountId: string;
  readonly provider: SsoProviderRecord;
  readonly issuer: string;
  readonly subject: string;
  /** What the provider reported: kept for display only, never matched on (threat model, T9). */
  readonly email: string | null;
}

/** Settings → Linked sign-ins, and the lookup every SSO sign-in starts with (threat model, T9). */
export interface LinkedSignInsService {
  /** By (issuer, subject) only: an email never finds a link. */
  findByIdentity(issuer: string, subject: string): LinkedIdentity | undefined;
  /** Records that the link was just used to sign in. */
  touch(id: string): void;
  /** The account's links, oldest first. */
  list(account: LinkingAccount): LinkedSignIn[];
  /** Removes a link; a user's last one stays, as users have no password (409 for the caller). */
  unlink(account: LinkingAccount, id: string, context: ActionContext): Unlinked;
  /**
   * Links the identity and records `linked-sign-in.added`; answers the link's id, or
   * `identity-already-linked` when (issuer, subject) is linked to any account (the unique index decides).
   */
  link(link: NewLink, context: ActionContext): { readonly id: string } | "identity-already-linked";
  /** Removes every link of the account, recording `linked-sign-in.removed` for each; answers how many. */
  removeAll(accountId: string, context: ActionContext): number;
}

/** What the link purpose needs of the sessions module: whether the session that started a link is still live. */
export interface LinkSessions {
  findLive(
    sessionId: string,
  ): { readonly state: SessionState; readonly account: { readonly id: string; readonly username: string } } | undefined;
}

export interface LinkedSignInsDependencies {
  readonly repository: SsoRepository;
  readonly audit: AuditService;
  readonly clock: Clock;
}

/** The admin has a password, so any link may go; a user must keep one. */
const canUnlinkLast = (account: LinkingAccount): boolean => account.role === "admin";

export function createLinkedSignInsService({ repository, audit, clock }: LinkedSignInsDependencies): LinkedSignInsService {
  const recordRemoved = (accountId: string, link: LinkedSignInRow, context: ActionContext): void => {
    const provider = repository.findProvider(link.providerId);
    if (provider === undefined) return;
    audit.record({
      action: "linked-sign-in.removed",
      actor: context.actor,
      outcome: "succeeded",
      target: { kind: "account", id: accountId },
      ...(context.origin === undefined ? {} : { origin: context.origin }),
      details: { linkedSignInId: link.id, providerId: provider.id, kind: provider.kind },
    });
  };

  return {
    findByIdentity(issuer, subject) {
      const row = repository.findLinkByIdentity(issuer, subject);
      return row === undefined ? undefined : { id: row.id, accountId: row.userId, providerId: row.providerId };
    },

    touch(id) {
      repository.touchLink(id, clock.now().toISOString());
    },

    list(account) {
      const links = repository.listLinks(account.id);
      const removable = canUnlinkLast(account) || links.length > 1;
      return links.map(({ link, provider }) => ({
        id: link.id,
        providerId: provider.id,
        providerName: provider.name,
        providerKind: provider.kind,
        providerEnabled: provider.enabled,
        email: link.emailAtLink,
        createdAt: link.createdAt,
        lastUsedAt: link.lastUsedAt,
        removable,
      }));
    },

    unlink(account, id, context) {
      const link = repository.findLink(account.id, id);
      if (link === undefined) return "not-found";
      if (!canUnlinkLast(account) && repository.listLinks(account.id).length <= 1) return "last-sign-in-method";
      repository.deleteLink(link.id);
      recordRemoved(account.id, link, context);
      return "removed";
    },

    link({ accountId, provider, issuer, subject, email }, context) {
      const row: LinkedSignInRow = {
        id: newId(clock),
        userId: accountId,
        providerId: provider.id,
        issuer,
        subject,
        emailAtLink: email,
        createdAt: clock.now().toISOString(),
        lastUsedAt: null,
      };
      try {
        repository.insertLink(row);
      } catch (error) {
        // Only the unique (issuer, subject) index says "taken"; anything else is a real failure.
        if (repository.findLinkByIdentity(issuer, subject) !== undefined) return "identity-already-linked";
        throw error;
      }
      audit.record({
        action: "linked-sign-in.added",
        actor: context.actor,
        outcome: "succeeded",
        target: { kind: "account", id: accountId },
        ...(context.origin === undefined ? {} : { origin: context.origin }),
        details: { linkedSignInId: row.id, providerId: provider.id, kind: provider.kind },
      });
      return { id: row.id };
    },

    removeAll(accountId, context) {
      const links = repository.listLinks(accountId);
      for (const { link } of links) {
        repository.deleteLink(link.id);
        recordRemoved(accountId, link, context);
      }
      return links.length;
    },
  };
}

const linkFailed = (failure: LinkFailure): SsoRedirect => ({ location: `${LINKED_SIGN_INS_PATH}?error=${failure}` });

/**
 * Settings → Linked sign-ins → Link: the flow carries the account and session that started it,
 * which must still be live and active at the callback. An identity linked to any account already,
 * this one included, is refused.
 */
export function createLinkPurpose({
  repository,
  audit,
  clock,
  sessions,
}: LinkedSignInsDependencies & { readonly sessions: LinkSessions }): SsoPurpose {
  return {
    purpose: LINK_PURPOSE,

    complete(identity, flow, origin) {
      if (flow.accountId === null || flow.sessionId === null) return linkFailed("link-failed");
      const session = sessions.findLive(flow.sessionId);
      if (session === undefined || session.state !== "active" || session.account.id !== flow.accountId) return linkFailed("link-failed");
      if (repository.findLinkByIdentity(identity.issuer, identity.subject) !== undefined) return linkFailed("identity-already-linked");

      const row: LinkedSignInRow = {
        id: newId(clock),
        userId: flow.accountId,
        providerId: flow.provider.id,
        issuer: identity.issuer,
        subject: identity.subject,
        emailAtLink: identity.email,
        createdAt: clock.now().toISOString(),
        lastUsedAt: null,
      };
      try {
        repository.insertLink(row);
      } catch {
        // The unique (issuer, subject) index: another callback linked it a moment ago.
        return linkFailed("identity-already-linked");
      }
      audit.record({
        action: "linked-sign-in.added",
        actor: { kind: "account", accountId: session.account.id, username: session.account.username },
        outcome: "succeeded",
        target: { kind: "account", id: flow.accountId },
        origin,
        details: { linkedSignInId: row.id, providerId: flow.provider.id, kind: flow.provider.kind },
      });
      return { location: `${LINKED_SIGN_INS_PATH}?linked=${flow.provider.id}` };
    },

    failed: () => linkFailed("link-failed"),
  };
}
