import { createAccountsModule, type AccountsService, type PasswordHashingParameters, type SetupService } from "./modules/accounts/index.ts";
import { createAuditService, type AuditService } from "./modules/audit/index.ts";
import {
  createInvitationsModule,
  type InvitationsService,
  type LinkPageLimit,
  type LinkPagesService,
  type UsersService,
} from "./modules/invitations/index.ts";
import { createFilesModule, type FilesService, type FreeSpaceProbes, type UploadsGateway } from "./modules/files/index.ts";
import { createMailService, type MailService, type MailTransportFactory } from "./modules/mail/index.ts";
import { dataPaths, type Clock, type Db, type Logger, type Secrets } from "./modules/platform/index.ts";
import {
  createAllowedFolders,
  createResourcesService,
  type AllowedFoldersService,
  type ResourceRootsOptions,
  type ResourcesService,
} from "./modules/resources/index.ts";
import {
  createMailedNotices,
  createSecondFactorsModule,
  type PasskeysService,
  type SecondFactorsService,
} from "./modules/second-factors/index.ts";
import { createSecuritySettingsService, type SecuritySettingsService } from "./modules/security-settings/index.ts";
import { createSessionsService, type SessionsService } from "./modules/sessions/index.ts";
import type { SettingsService } from "./modules/settings/index.ts";
import {
  createSecondFactorStep,
  createSignInService,
  createSsoSignInPurpose,
  type SecondFactorStepService,
  type SignInGate,
  type SignInLimitsDependencies,
  type SignInService,
} from "./modules/sign-in/index.ts";
import {
  createShareLinksModule,
  type PublicShareLinks,
  type ShareLinksService,
  type ShareTokenLimit,
} from "./modules/share-links/index.ts";
import { createSsoServices, type SsoFetch, type SsoServices } from "./modules/sso/index.ts";
import { createUpdatesService, updatesOff, type UpdatesOptions, type UpdatesService } from "./modules/updates/index.ts";

/** Every module service the app's routes call, made once per process. */
export interface AppServices {
  readonly settings: SettingsService;
  readonly audit: AuditService;
  readonly accounts: AccountsService;
  readonly setup: SetupService;
  readonly sessions: SessionsService;
  readonly signIn: SignInService;
  readonly secondFactors: SecondFactorsService;
  readonly passkeys: PasskeysService;
  readonly secondFactorStep: SecondFactorStepService;
  readonly securitySettings: SecuritySettingsService;
  readonly resources: ResourcesService;
  /** Allowing folders from the admin interface; only while `ALLOW_FOLDERS_FROM_UI` is on (`resourceRoots.allowFromUi`). */
  readonly allowedFolders: AllowedFoldersService | undefined;
  readonly sso: SsoServices;
  readonly mail: MailService;
  readonly invitations: InvitationsService;
  /** The public invitation and re-link pages. */
  readonly linkPages: LinkPagesService;
  readonly linkPageLimit: LinkPageLimit;
  readonly users: UsersService;
  readonly files: FilesService;
  /** tus, behind the upload routes. */
  readonly uploads: UploadsGateway;
  readonly shareLinks: ShareLinksService;
  /** The public share API behind `/s/:token`. */
  readonly publicShareLinks: PublicShareLinks;
  readonly shareTokenLimit: ShareTokenLimit;
  /** Settings → Updates: the release check and, while `UPDATE_FROM_UI` is on, installing from there. */
  readonly updates: UpdatesService;
}

/** Where uploads are staged and how free space is read; tests pass a temp folder and fakes. */
export interface UploadsOptions {
  /** `DATA_DIR/uploads` unless given. */
  readonly stagingDir?: string;
  readonly freeSpace?: Partial<FreeSpaceProbes>;
}

export interface ServicesDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: SettingsService;
  /** The service's own folders (DATA_DIR above all), which no resource may overlap. */
  readonly resourceRoots: ResourceRootsOptions;
  /** The master key's secrets, which authenticator apps and SMB passwords need; the CLI has none. */
  readonly secrets?: Secrets;
  /** The stack.md parameters unless given; tests pass cheap ones. */
  readonly passwordHashing?: PasswordHashingParameters;
  /**
   * Makes the sign-in gate over the services it needs: the server's `createSignInLimits` (threat
   * model, T11), which also needs the master key's secrets; `openSignInGate` where no password is
   * proved, such as the CLI.
   */
  readonly signInGate: (services: Omit<SignInLimitsDependencies, "secrets">) => SignInGate;
  /** `PUBLIC_ORIGIN`, which SSO redirect URIs and the passkeys' relying party are built from. */
  readonly publicOrigin: string;
  /** How the sso module reaches providers: `globalThis.fetch` unless given (tests route them to fakes). */
  readonly ssoFetch?: SsoFetch;
  /** Tests only: a shorter discovery timeout than the 5 seconds. */
  readonly ssoDiscoveryTimeoutMs?: number;
  /** Tests only: how the mail module reaches the SMTP server; nodemailer when left out. */
  readonly mailTransport?: MailTransportFactory;
  /** Upload staging and free-space probes; the defaults under `resourceRoots.dataDir` unless given. */
  readonly uploads?: UploadsOptions;
  /** `UPDATE_CHECK` and `UPDATE_FROM_UI` (and the fakes tests use); both off when left out, as for the CLI. */
  readonly updates?: UpdatesOptions;
}

export function createServices({
  db,
  clock,
  logger,
  settings,
  resourceRoots,
  secrets,
  passwordHashing,
  signInGate,
  publicOrigin,
  ssoFetch,
  ssoDiscoveryTimeoutMs,
  mailTransport,
  uploads,
  updates: updatesOptions = updatesOff,
}: ServicesDependencies): AppServices {
  const audit = createAuditService({ db, clock, logger, settings });
  const { accounts, setup, hasher } = createAccountsModule({
    db,
    clock,
    logger,
    audit,
    ...(passwordHashing === undefined ? {} : { passwordHashing }),
  });
  const sessions = createSessionsService({ db, clock, settings, audit, accounts });
  const mail = createMailService({
    db,
    clock,
    audit,
    secrets,
    publicOrigin,
    logger,
    ...(mailTransport === undefined ? {} : { transport: mailTransport }),
  });
  const notices = createMailedNotices({ mail, findAccountEmail: (id) => accounts.findById(id)?.email ?? null, logger });
  const { secondFactors, passkeys } = createSecondFactorsModule({ db, clock, audit, hasher, secrets, publicOrigin, notices });
  const gate = signInGate({ db, clock, settings, audit });
  const signIn = createSignInService({ accounts, sessions, secondFactors, passkeys, audit, gate });
  const secondFactorStep = createSecondFactorStep({ accounts, sessions, secondFactors, passkeys, audit });
  const securitySettings = createSecuritySettingsService(settings, audit);
  const resources = createResourcesService({ db, clock, logger, audit, secrets, roots: resourceRoots });
  const allowedFolders = createAllowedFolders({
    roots: resourceRoots,
    // sign-in and second-factors sit beside or above resources (domain.md), so they come in as functions.
    reauthenticate: async (caller, reauthentication, origin) => signIn.reauthenticate(caller, reauthentication, origin),
    notifyFolderAllowed: (accountId, path) => notices.notify({ kind: "folder-allowed", accountId, path }),
    audit,
    clock,
    logger,
  });
  const sso = createSsoServices({
    db,
    clock,
    audit,
    secrets,
    publicOrigin,
    sessions,
    gate,
    ...(ssoFetch === undefined ? {} : { fetch: ssoFetch }),
    ...(ssoDiscoveryTimeoutMs === undefined ? {} : { discoveryTimeoutMs: ssoDiscoveryTimeoutMs }),
  });
  sso.purposes.register(createSsoSignInPurpose({ accounts, sessions, linkedSignIns: sso.linkedSignIns, audit }));
  const invitations = createInvitationsModule({
    db,
    clock,
    logger,
    audit,
    settings,
    secrets,
    publicOrigin,
    mail,
    accounts,
    sessions,
    sso,
    resources,
  });
  for (const purpose of invitations.purposes) sso.purposes.register(purpose);
  const files = createFilesModule({
    db,
    clock,
    logger,
    audit,
    settings,
    accounts,
    resources,
    stagingDir: uploads?.stagingDir ?? dataPaths({ dataDir: resourceRoots.dataDir }).uploadsDir,
    ...(uploads?.freeSpace === undefined ? {} : { freeSpace: uploads.freeSpace }),
  });
  const shareLinks = createShareLinksModule({ db, clock, audit, resources, hasher, secrets, publicOrigin, settings });
  const updates = createUpdatesService({
    db,
    clock,
    logger,
    audit,
    mail,
    findAccountEmail: (id) => accounts.findById(id)?.email ?? null,
    reauthenticate: async (caller, reauthentication, origin) => signIn.reauthenticate(caller, reauthentication, origin),
    dataDir: resourceRoots.dataDir,
    options: updatesOptions,
  });
  return {
    settings,
    audit,
    accounts,
    setup,
    sessions,
    signIn,
    secondFactors,
    passkeys,
    secondFactorStep,
    securitySettings,
    resources,
    allowedFolders,
    sso,
    mail,
    invitations: invitations.invitations,
    linkPages: invitations.linkPages,
    linkPageLimit: invitations.linkPageLimit,
    users: invitations.users,
    files: files.files,
    uploads: files.uploads,
    shareLinks: shareLinks.shareLinks,
    publicShareLinks: shareLinks.publicShareLinks,
    shareTokenLimit: shareLinks.shareTokenLimit,
    updates,
  };
}
