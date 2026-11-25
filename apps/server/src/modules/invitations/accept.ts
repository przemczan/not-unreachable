import {
  acceptFailures,
  invitationPath,
  problemTypes,
  relinkFailures,
  relinkPath,
  SSO_SIGN_IN_COMPLETE_PATH,
  SSO_SIGN_IN_FAILED_PATH,
  type AcceptFailure,
  type AcceptInvitationRequest,
  type InvitationOffer,
  type RelinkFailure,
  type RelinkOffer,
} from "@not-unreachable/contracts";
import { z } from "zod";
import { HttpProblem } from "../../http/index.ts";
import type { AccountRecord, AccountsService } from "../accounts/index.ts";
import { actorOf, type AuditActor, type AuditService } from "../audit/index.ts";
import type { Clock, Logger } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import { sessionCookie, type SessionsService } from "../sessions/index.ts";
import type {
  LinkedSignInsService,
  SsoFlow,
  SsoFlowsService,
  SsoIdentity,
  SsoOrigin,
  SsoProvidersService,
  SsoPurpose,
  SsoRedirect,
  StartedFlow,
} from "../sso/index.ts";
import { invalidLink, type LinkKind, type LinkTokens } from "./links.ts";
import type { InvitationsRepository } from "./repository.ts";
import type { Serial } from "./serial.ts";
import { usernameProblem, type Usernames } from "./usernames.ts";

export const ACCEPT_INVITATION_PURPOSE = "accept-invitation";
export const RELINK_PURPOSE = "relink";

/** What an accept flow carries from its start to its callback; none of it is secret. */
const acceptDataSchema = z.strictObject({ invitationId: z.uuid(), username: z.string(), displayName: z.string() });
const relinkDataSchema = z.strictObject({ invitationId: z.uuid() });

/** The public invitation and re-link pages; every invalid link is the same 404 (threat model, T1). */
export interface LinkPagesService {
  invitationOffer(token: string): Promise<InvitationOffer>;
  /** Checks the link, the username (409) and the provider (404), then starts the flow. */
  startAccept(token: string, request: AcceptInvitationRequest, origin: SsoOrigin): Promise<StartedFlow>;
  relinkOffer(token: string): RelinkOffer;
  startRelink(token: string, providerId: string, origin: SsoOrigin): Promise<StartedFlow>;
}

export interface AcceptDependencies {
  readonly repository: InvitationsRepository;
  readonly links: LinkTokens;
  readonly usernames: Usernames;
  readonly accounts: Pick<AccountsService, "create" | "findById" | "isEmailTaken">;
  readonly sessions: Pick<SessionsService, "start" | "revokeAll">;
  readonly flows: Pick<SsoFlowsService, "start">;
  readonly providers: Pick<SsoProvidersService, "listForSignIn">;
  readonly linkedSignIns: Pick<LinkedSignInsService, "findByIdentity" | "link" | "removeAll">;
  readonly resources: Pick<ResourcesService, "createHome" | "homeExists" | "removeHome">;
  readonly audit: AuditService;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Shared by both purposes, so no two callbacks interleave. */
  readonly serial: Serial;
}

/** A refusal inside the accept or re-link transaction, which rolls it back. */
class LinkRefused extends Error {
  override readonly name = "LinkRefused";
  readonly failure: AcceptFailure | RelinkFailure;

  constructor(failure: AcceptFailure | RelinkFailure) {
    super(`Refused: ${failure}`);
    this.failure = failure;
  }
}

const startedOrNotFound = (started: StartedFlow | undefined): StartedFlow => {
  // The page lists only enabled providers, so a 404 tells nobody anything new.
  if (started === undefined) throw new HttpProblem(404, problemTypes.notFound);
  return started;
};

function parseData<Schema extends z.ZodType>(schema: Schema, flow: SsoFlow | undefined): z.output<Schema> | undefined {
  if (flow === undefined || flow.purposeData === null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(flow.purposeData));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function createLinkPages({ links, usernames, flows, providers }: AcceptDependencies): LinkPagesService {
  const pendingOrInvalid = (token: string, kind: LinkKind) => {
    const row = links.findPending(token, kind);
    if (row === undefined) throw invalidLink();
    return row;
  };

  return {
    async invitationOffer(token) {
      const row = pendingOrInvalid(token, "invite");
      return {
        providers: providers.listForSignIn(),
        suggestedUsername: await usernames.suggestFrom(row.email),
        verifyEmail: row.verifyEmail,
      };
    },

    async startAccept(token, { providerId, username, displayName }, origin) {
      const row = pendingOrInvalid(token, "invite");
      const refusal = await usernames.refusalFor(username);
      if (refusal !== undefined) throw usernameProblem(refusal);
      const purposeData = JSON.stringify({ invitationId: row.id, username, displayName });
      return startedOrNotFound(await flows.start(providerId, ACCEPT_INVITATION_PURPOSE, { purposeData }, origin));
    },

    relinkOffer(token) {
      pendingOrInvalid(token, "relink");
      return { providers: providers.listForSignIn() };
    },

    async startRelink(token, providerId, origin) {
      const row = pendingOrInvalid(token, "relink");
      const purposeData = JSON.stringify({ invitationId: row.id });
      return startedOrNotFound(await flows.start(providerId, RELINK_PURPOSE, { purposeData }, origin));
    },
  };
}

/** Back to the link's own page with `?error=`; the sign-in page when the link can't be named any more. */
function failureLocation(
  { repository, links, logger }: Pick<AcceptDependencies, "repository" | "links" | "logger">,
  invitationId: string | undefined,
  pagePath: (token: string) => string,
  failure: string,
): SsoRedirect {
  const row = invitationId === undefined ? undefined : repository.findById(invitationId);
  if (row === undefined) return { location: SSO_SIGN_IN_FAILED_PATH };
  try {
    return { location: `${pagePath(links.tokenOf(row))}?error=${failure}` };
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : "unknown", invitationId }, "The link's token could not be read back");
    return { location: SSO_SIGN_IN_FAILED_PATH };
  }
}

/** The new session, as an SSO sign-in starts a user's: active, with a recent sign-in. */
function signedIn(
  { sessions, audit }: Pick<AcceptDependencies, "sessions" | "audit">,
  account: AccountRecord,
  origin: SsoOrigin,
): SsoRedirect {
  const { token } = sessions.start({ account, state: "active", recentSignIn: true, method: "sso", origin });
  audit.record({
    action: "sign-in.succeeded",
    actor: actorOf({ accountId: account.id, username: account.username }),
    outcome: "succeeded",
    target: { kind: "account", id: account.id },
    origin,
    details: { method: "sso", secondFactor: null },
  });
  return { location: SSO_SIGN_IN_COMPLETE_PATH, cookies: [sessionCookie(token)] };
}

export type EmailCheckFailure = Extract<AcceptFailure, "email-not-verified" | "email-mismatch">;

const normalizedEmail = (email: string): string => email.trim().toLowerCase();

/**
 * An invitation that requires a verified email (threat model, T9): the provider must report, as
 * verified, the invitation's email, trimmed and compared case-insensitively. No other folding.
 */
export function verifiedEmailFailure(
  invitationEmail: string | null,
  identity: Pick<SsoIdentity, "verifiedEmails">,
): EmailCheckFailure | undefined {
  if (identity.verifiedEmails.length === 0) return "email-not-verified";
  // Creating an invitation refuses verification without an email; were one stored anyway, nothing matches.
  if (invitationEmail === null) return "email-mismatch";
  const invited = normalizedEmail(invitationEmail);
  return identity.verifiedEmails.some((email) => normalizedEmail(email) === invited) ? undefined : "email-mismatch";
}

const isOneOf = <Failure extends string>(failures: readonly Failure[], value: string): value is Failure =>
  failures.some((failure) => failure === value);

/** The refusal a failed transaction threw, when the page knows it; `otherwise` for anything else. */
function failureOf<Failure extends string>(error: unknown, failures: readonly Failure[], otherwise: Failure): Failure {
  return error instanceof LinkRefused && isOneOf(failures, error.failure) ? error.failure : otherwise;
}

/**
 * Accepting an invitation (threat model, T1 and T9): the only way a user account comes to exist.
 * All or nothing, one callback at a time: the checks again, then the home folder, then one
 * transaction that uses the invitation (a conditional UPDATE), creates the account and links the
 * identity. If anything fails, the folder this callback made goes too, and nothing is kept.
 */
export function createAcceptInvitationPurpose(dependencies: AcceptDependencies): SsoPurpose {
  const { repository, links, usernames, accounts, linkedSignIns, resources, audit, clock, logger, serial } = dependencies;
  const fail = (invitationId: string | undefined, failure: AcceptFailure): SsoRedirect =>
    failureLocation(dependencies, invitationId, invitationPath, failure);

  /** The transaction: it can't await, and any throw rolls all of it back. */
  const createAccount = (
    invitationId: string,
    data: z.output<typeof acceptDataSchema>,
    identity: SsoIdentity,
    flow: SsoFlow,
    origin: SsoOrigin,
  ): AccountRecord =>
    repository.transaction(() => {
      if (!repository.claim(invitationId, clock.now().toISOString(), null)) throw new LinkRefused("invitation-invalid");
      const invitation = repository.findById(invitationId);
      // The invitation's email, never the provider's (T9): verified by the check in `complete` when the
      // invitation requires it, the admin's word otherwise. Null when another account has it already.
      const invited = invitation?.email ?? null;
      const email = invited !== null && !accounts.isEmailTaken(invited) ? invited : null;
      const account = accounts.create({ username: data.username, email, displayName: data.displayName, role: "user" });
      repository.setAcceptedUser(invitationId, account.id);
      const actor: AuditActor = actorOf({ accountId: account.id, username: account.username });
      audit.record({
        action: "account.created",
        actor,
        outcome: "succeeded",
        target: { kind: "account", id: account.id },
        origin,
        details: { username: account.username, invitationId },
      });
      const linked = linkedSignIns.link(
        { accountId: account.id, provider: flow.provider, issuer: identity.issuer, subject: identity.subject, email: identity.email },
        { actor, origin },
      );
      if (linked === "identity-already-linked") throw new LinkRefused("identity-already-linked");
      audit.record({
        action: "invitation.accepted",
        actor,
        outcome: "succeeded",
        target: { kind: "invitation", id: invitationId },
        origin,
        details: { accountId: account.id, username: account.username },
      });
      return account;
    });

  const complete = async (identity: SsoIdentity, flow: SsoFlow, origin: SsoOrigin): Promise<SsoRedirect> => {
    const data = parseData(acceptDataSchema, flow);
    if (data === undefined) return fail(undefined, "accept-failed");
    const invitation = links.findPendingById(data.invitationId, "invite");
    if (invitation === undefined) return fail(data.invitationId, "invitation-invalid");
    const emailFailure = invitation.verifyEmail ? verifiedEmailFailure(invitation.email, identity) : undefined;
    if (emailFailure !== undefined) {
      audit.record({
        action: "invitation.refused",
        actor: { kind: "anonymous" },
        outcome: "denied",
        target: { kind: "invitation", id: invitation.id },
        origin,
        details: { reason: emailFailure, providerId: flow.provider.id },
      });
      return fail(invitation.id, emailFailure);
    }
    if (linkedSignIns.findByIdentity(identity.issuer, identity.subject) !== undefined) {
      return fail(data.invitationId, "identity-already-linked");
    }
    const refusal = await usernames.refusalFor(data.username);
    if (refusal !== undefined) return fail(data.invitationId, refusal);

    // A home recorded already isn't this callback's to remove if the rest fails.
    const madeHome = !(await resources.homeExists(data.username));
    try {
      await resources.createHome(data.username);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "The new user's home could not be made");
      return fail(data.invitationId, "accept-failed");
    }

    let account: AccountRecord;
    try {
      account = createAccount(data.invitationId, data, identity, flow, origin);
    } catch (error) {
      if (!(error instanceof LinkRefused)) logger.error({ err: error }, "Accepting an invitation failed");
      if (madeHome) {
        // Only when still empty: a home holding anything was never this callback's.
        await resources.removeHome(data.username, { onlyIfEmpty: true }).catch((removeError: unknown) => {
          logger.error({ err: removeError }, "The home of a failed invitation could not be removed");
        });
      }
      return fail(data.invitationId, failureOf(error, acceptFailures, "accept-failed"));
    }
    return signedIn(dependencies, account, origin);
  };

  return {
    purpose: ACCEPT_INVITATION_PURPOSE,
    complete: (identity, flow, origin) => serial.run(() => complete(identity, flow, origin)),
    failed: (_failure, flow) => fail(parseData(acceptDataSchema, flow)?.invitationId, "accept-failed"),
  };
}

/**
 * A re-link link (the admin's answer to a user who lost their sign-in): the new identity replaces
 * every earlier one, and every session of the user ends. One transaction, one callback at a time.
 */
export function createRelinkPurpose(dependencies: AcceptDependencies): SsoPurpose {
  const { repository, links, accounts, sessions, linkedSignIns, audit, clock, serial } = dependencies;
  const fail = (invitationId: string | undefined, failure: RelinkFailure): SsoRedirect =>
    failureLocation(dependencies, invitationId, relinkPath, failure);

  const relink = (invitationId: string, account: AccountRecord, identity: SsoIdentity, flow: SsoFlow, origin: SsoOrigin): void =>
    repository.transaction(() => {
      if (!repository.claim(invitationId, clock.now().toISOString(), account.id)) {
        throw new LinkRefused("invitation-invalid");
      }
      const context = { actor: actorOf({ accountId: account.id, username: account.username }), origin };
      const removedLinks = linkedSignIns.removeAll(account.id, context);
      const linked = linkedSignIns.link(
        { accountId: account.id, provider: flow.provider, issuer: identity.issuer, subject: identity.subject, email: identity.email },
        context,
      );
      if (linked === "identity-already-linked") throw new LinkRefused("identity-already-linked");
      const revokedSessions = sessions.revokeAll(account.id, "relinked", context);
      audit.record({
        action: "relink.used",
        ...context,
        outcome: "succeeded",
        target: { kind: "account", id: account.id },
        details: { relinkId: invitationId, providerId: flow.provider.id, removedLinks, revokedSessions },
      });
    });

  const complete = (identity: SsoIdentity, flow: SsoFlow, origin: SsoOrigin): SsoRedirect => {
    const data = parseData(relinkDataSchema, flow);
    if (data === undefined) return fail(undefined, "relink-failed");
    const row = links.findPendingById(data.invitationId, "relink");
    if (row === undefined) return fail(data.invitationId, "invitation-invalid");
    const account = row.targetUserId === null ? undefined : accounts.findById(row.targetUserId);
    if (account?.role !== "user" || account.status !== "active") return fail(data.invitationId, "relink-failed");
    const existing = linkedSignIns.findByIdentity(identity.issuer, identity.subject);
    // Linked to this very user is fine: it is removed and linked again.
    if (existing !== undefined && existing.accountId !== account.id) return fail(data.invitationId, "identity-already-linked");
    try {
      relink(data.invitationId, account, identity, flow, origin);
    } catch (error) {
      if (!(error instanceof LinkRefused)) dependencies.logger.error({ err: error }, "Re-linking failed");
      return fail(data.invitationId, failureOf(error, relinkFailures, "relink-failed"));
    }
    return signedIn(dependencies, account, origin);
  };

  return {
    purpose: RELINK_PURPOSE,
    complete: (identity, flow, origin) => serial.run(async () => complete(identity, flow, origin)),
    failed: (_failure, flow) => fail(parseData(relinkDataSchema, flow)?.invitationId, "relink-failed"),
  };
}
