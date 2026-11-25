import { problemTypes, type InvitationState } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import type { AuditActor, AuditOrigin } from "../audit/index.ts";
import type { MailService, MailTemplate } from "../mail/index.ts";
import { DAY_MS, hashToken, newId, newToken, type Clock, type EnvelopeAad, type Logger, type Secrets } from "../platform/index.ts";
import type { InvitationsRepository } from "./repository.ts";
import type { InvitationRow } from "./schema.ts";

export type LinkKind = InvitationRow["kind"];

/** Who acts on the admin's routes, and from where, for the audit log. */
export interface AdminContext {
  readonly actor: AuditActor;
  readonly origin: AuditOrigin;
}

export interface NewLink {
  readonly kind: LinkKind;
  readonly email: string | null;
  readonly sendByEmail: boolean;
  readonly verifyEmail: boolean;
  readonly targetUserId: string | null;
  readonly createdBy: string | null;
  readonly lifetimeDays: number;
}

export interface IssuedLink {
  readonly row: InvitationRow;
  /** Only for the link and the email; the row holds its SHA-256 and an envelope. */
  readonly token: string;
}

/** Invitation and re-link tokens (threat model, T1): issued, found and read back. */
export interface LinkTokens {
  issue(link: NewLink): IssuedLink;
  /** The pending link of this kind the token names; undefined for any other token, malformed ones too. */
  findPending(token: string, kind: LinkKind): InvitationRow | undefined;
  /** The pending link of this kind by its id. */
  findPendingById(id: string, kind: LinkKind): InvitationRow | undefined;
  /** The token again, from the row's envelope. */
  tokenOf(row: InvitationRow): string;
  stateOf(row: InvitationRow): InvitationState;
}

export interface LinkTokensDependencies {
  readonly repository: InvitationsRepository;
  readonly secrets: Secrets | undefined;
  readonly clock: Clock;
}

export const tokenAad = (id: string): EnvelopeAad => ({ table: "invitations", column: "token", rowId: id });

/**
 * Every invalid link, whatever the reason, gets this very answer: the same status, title and no
 * detail, so nobody can tell an unknown link from a used, revoked or expired one (T1).
 */
export const invalidLink = (): HttpProblem => new HttpProblem(404, problemTypes.invitationInvalid);

export function createLinkTokens({ repository, secrets, clock }: LinkTokensDependencies): LinkTokens {
  const requireSecrets = (): Secrets => {
    if (secrets === undefined) throw new Error("Invitation links need the master key");
    return secrets;
  };

  const stateOf = (row: InvitationRow): InvitationState => {
    if (row.acceptedAt !== null) return "accepted";
    if (row.revokedAt !== null) return "revoked";
    return Date.parse(row.expiresAt) <= clock.now().getTime() ? "expired" : "pending";
  };

  const pendingOfKind = (row: InvitationRow | undefined, kind: LinkKind): InvitationRow | undefined =>
    row?.kind === kind && stateOf(row) === "pending" ? row : undefined;

  return {
    issue({ kind, email, sendByEmail, verifyEmail, targetUserId, createdBy, lifetimeDays }) {
      const id = newId(clock);
      const token = newToken();
      const now = clock.now();
      const row: InvitationRow = {
        id,
        kind,
        targetUserId,
        tokenHash: hashToken(token),
        token: requireSecrets().encrypt("invitation", tokenAad(id), token),
        email,
        sendByEmail,
        verifyEmail,
        createdBy,
        expiresAt: new Date(now.getTime() + lifetimeDays * DAY_MS).toISOString(),
        acceptedUserId: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: now.toISOString(),
      };
      repository.insert(row);
      return { row, token };
    },

    findPending: (token, kind) => pendingOfKind(repository.findByTokenHash(hashToken(token)), kind),

    findPendingById: (id, kind) => pendingOfKind(repository.findById(id), kind),

    tokenOf: (row) => requireSecrets().decrypt("invitation", tokenAad(row.id), row.token),

    stateOf,
  };
}

export interface LinkMailDependencies {
  readonly mail: Pick<MailService, "isConfigured" | "send">;
  readonly logger: Logger;
}

/**
 * Emails a link when there is an address and SMTP is set up; answers whether it went. A failure is
 * logged, never thrown: the link exists, and the admin can copy it or send it again.
 */
export async function emailLink({ mail, logger }: LinkMailDependencies, template: MailTemplate, to: string | null): Promise<boolean> {
  if (to === null || !mail.isConfigured()) return false;
  try {
    await mail.send(template, to);
    return true;
  } catch (error) {
    logger.warn({ kind: template.kind, err: error instanceof Error ? error.message : "unknown" }, "A link could not be emailed");
    return false;
  }
}
