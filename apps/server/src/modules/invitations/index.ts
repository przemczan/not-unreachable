import type { AccountsService } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import type { MailService } from "../mail/index.ts";
import type { Clock, Db, Logger, Secrets } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import type { SessionsService } from "../sessions/index.ts";
import type { SettingsService } from "../settings/index.ts";
import type { SsoPurpose, SsoServices } from "../sso/index.ts";
import { createAcceptInvitationPurpose, createLinkPages, createRelinkPurpose, type LinkPagesService } from "./accept.ts";
import { createLinkPageLimit, type LinkPageLimit } from "./link-page-limit.ts";
import { createLinkTokens } from "./links.ts";
import { createInvitationsRepository } from "./repository.ts";
import { createSerial } from "./serial.ts";
import { createInvitationsService, type InvitationsService } from "./service.ts";
import { createUsernames } from "./usernames.ts";
import { createUsersService, type UsersService } from "./users.ts";

export { ACCEPT_INVITATION_PURPOSE, RELINK_PURPOSE, type LinkPagesService } from "./accept.ts";
export { LINK_PAGE_LIMIT, linkPageRoutes, registerLinkPageLimit, type LinkPageLimit } from "./link-page-limit.ts";
export { tokenAad, type AdminContext } from "./links.ts";
export { createInvitationsHandlers, type InvitationsHandlersDependencies, type InvitationsRoutes } from "./routes.ts";
export { invitations, reservedUsernames, type InvitationRow, type ReservedUsernameRow } from "./schema.ts";
export type { InvitationsService, NewInvitation } from "./service.ts";
export type { UserChange, UsersService } from "./users.ts";

export interface InvitationsDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly settings: SettingsService;
  /** The master key's secrets, which the tokens' envelope copies need; the CLI has none. */
  readonly secrets: Secrets | undefined;
  /** `PUBLIC_ORIGIN`, which every link is built from (threat model, T15). */
  readonly publicOrigin: string;
  readonly mail: MailService;
  readonly accounts: AccountsService;
  readonly sessions: SessionsService;
  readonly sso: SsoServices;
  readonly resources: ResourcesService;
}

export interface InvitationsModule {
  readonly invitations: InvitationsService;
  readonly linkPages: LinkPagesService;
  readonly users: UsersService;
  readonly linkPageLimit: LinkPageLimit;
  /** `accept-invitation` and `relink`, for the sso module's registry. */
  readonly purposes: readonly SsoPurpose[];
}

export function createInvitationsModule(dependencies: InvitationsDependencies): InvitationsModule {
  const { db, clock, logger, audit, settings, secrets, publicOrigin, mail, accounts, sessions, sso, resources } = dependencies;
  const repository = createInvitationsRepository(db);
  const links = createLinkTokens({ repository, secrets, clock });
  const usernames = createUsernames({ accounts, resources, repository });
  const accept = {
    repository,
    links,
    usernames,
    accounts,
    sessions,
    flows: sso.flows,
    providers: sso.providers,
    linkedSignIns: sso.linkedSignIns,
    resources,
    audit,
    clock,
    logger,
    serial: createSerial(),
  };
  return {
    invitations: createInvitationsService({ repository, links, accounts, resources, mail, audit, logger, clock, publicOrigin }),
    linkPages: createLinkPages(accept),
    users: createUsersService({
      repository,
      links,
      accounts,
      sessions,
      linkedSignIns: sso.linkedSignIns,
      resources,
      settings,
      mail,
      audit,
      clock,
      logger,
      publicOrigin,
    }),
    linkPageLimit: createLinkPageLimit({ settings, audit, clock }),
    purposes: [createAcceptInvitationPurpose(accept), createRelinkPurpose(accept)],
  };
}
