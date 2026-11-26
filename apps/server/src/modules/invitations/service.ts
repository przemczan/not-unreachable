import {
  invitationPath,
  problemTypes,
  type CreatedInvitation,
  type createInvitationRequestSchema,
  type Invitation,
  type InvitationLink,
  type Invitations,
} from "@not-unreachable/contracts";
import type { z } from "zod";
import { HttpProblem } from "../../http/index.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import { MailNotConfiguredError, MailSendFailedError, type MailService } from "../mail/index.ts";
import type { Clock, Logger } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import { emailLink, type AdminContext, type LinkTokens } from "./links.ts";
import type { InvitationsRepository } from "./repository.ts";
import type { InvitationRow } from "./schema.ts";

export type NewInvitation = z.output<typeof createInvitationRequestSchema>;

/** The admin's Invitations tab. Every refusal is an `HttpProblem`; an unknown id is a 404. */
export interface InvitationsService {
  list(): Invitations;
  /**
   * How many invitations the list would show as `pending` now: neither accepted nor revoked, and not
   * expired. Re-link links aren't invitations, so they don't count. One aggregate query.
   */
  countPending(): number;
  /**
   * 409 `home-root-not-set` while there is no home root, 409 `smtp-not-configured` when asked to send
   * it without SMTP. Emails the link only when asked; a failed email doesn't fail it.
   */
  create(request: NewInvitation, context: AdminContext): Promise<CreatedInvitation>;
  /** A pending invitation's link again (409 `invitation-invalid` once it isn't pending). */
  linkOf(id: string): InvitationLink;
  /** 409 `invitation-invalid` (also when it isn't sent by email), 409 `smtp-not-configured`, 502 `mail-send-failed`. */
  resend(id: string, context: AdminContext): Promise<Invitation>;
  /** 409 `invitation-invalid` once it isn't pending. */
  revoke(id: string, context: AdminContext): void;
}

export interface InvitationsServiceDependencies {
  readonly repository: InvitationsRepository;
  readonly links: LinkTokens;
  readonly accounts: Pick<AccountsService, "findById">;
  readonly resources: Pick<ResourcesService, "isHomeRootSet">;
  readonly mail: Pick<MailService, "isConfigured" | "send">;
  readonly audit: AuditService;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly publicOrigin: string;
}

const notPending = (): HttpProblem => new HttpProblem(409, problemTypes.invitationInvalid, "This invitation is no longer pending.");

export function createInvitationsService({
  repository,
  links,
  accounts,
  resources,
  mail,
  audit,
  logger,
  clock,
  publicOrigin,
}: InvitationsServiceDependencies): InvitationsService {
  const toInvitation = (row: InvitationRow): Invitation => ({
    id: row.id,
    email: row.email,
    sendByEmail: row.sendByEmail,
    verifyEmail: row.verifyEmail,
    state: links.stateOf(row),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedUsername: row.acceptedUserId === null ? null : (accounts.findById(row.acceptedUserId)?.username ?? null),
    revokedAt: row.revokedAt,
  });

  const linkFor = (token: string): string => new URL(invitationPath(token), publicOrigin).href;

  const find = (id: string): InvitationRow => {
    const row = repository.findById(id);
    if (row?.kind !== "invite") throw new HttpProblem(404, problemTypes.notFound);
    return row;
  };

  const findPending = (id: string): InvitationRow => {
    const row = find(id);
    if (links.stateOf(row) !== "pending") throw notPending();
    return row;
  };

  const record = (action: "invitation.resent" | "invitation.revoked", row: InvitationRow, context: AdminContext): void => {
    audit.record({
      action,
      actor: context.actor,
      outcome: "succeeded",
      target: { kind: "invitation", id: row.id },
      origin: context.origin,
      details: {},
    });
  };

  return {
    list: () => ({ invitations: repository.listInvites().map(toInvitation) }),

    countPending: () => repository.countPendingInvites(clock.now().toISOString()),

    async create({ email, expiresInDays, sendByEmail, verifyEmail }, context) {
      if (!resources.isHomeRootSet()) {
        throw new HttpProblem(409, problemTypes.homeRootNotSet, "Choose where users' home folders go before you invite anyone.");
      }
      if (sendByEmail && !mail.isConfigured()) {
        throw new HttpProblem(409, problemTypes.smtpNotConfigured, "Set up email before you send an invitation by email.");
      }
      const { row, token } = links.issue({
        kind: "invite",
        email: email?.toLowerCase() ?? null,
        sendByEmail,
        verifyEmail,
        targetUserId: null,
        createdBy: context.actor.kind === "account" ? context.actor.accountId : null,
        lifetimeDays: expiresInDays,
      });
      const emailed =
        sendByEmail && (await emailLink({ mail, logger }, { kind: "invitation", token, expiresAt: row.expiresAt }, row.email));
      audit.record({
        action: "invitation.created",
        actor: context.actor,
        outcome: "succeeded",
        target: { kind: "invitation", id: row.id },
        origin: context.origin,
        details: { expiresAt: row.expiresAt, hasEmail: row.email !== null, sendByEmail, verifyEmail, emailed },
      });
      return { invitation: toInvitation(row), link: linkFor(token), emailed };
    },

    linkOf: (id) => ({ link: linkFor(links.tokenOf(findPending(id))) }),

    async resend(id, context) {
      const row = findPending(id);
      if (!row.sendByEmail || row.email === null) {
        throw new HttpProblem(409, problemTypes.invitationInvalid, "This invitation isn't sent by email.");
      }
      try {
        await mail.send({ kind: "invitation", token: links.tokenOf(row), expiresAt: row.expiresAt }, row.email);
      } catch (error) {
        if (error instanceof MailNotConfiguredError) throw new HttpProblem(409, problemTypes.smtpNotConfigured);
        if (error instanceof MailSendFailedError) throw new HttpProblem(502, problemTypes.mailSendFailed);
        throw error;
      }
      record("invitation.resent", row, context);
      return toInvitation(row);
    },

    revoke(id, context) {
      const row = find(id);
      if (!repository.revoke(row.id, clock.now().toISOString())) throw notPending();
      record("invitation.revoked", row, context);
    },
  };
}
