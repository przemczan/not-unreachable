import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRUSTED_KEYS_FOLDER } from "@not-unreachable/mount-helper/release-verify";
import type { AuditService } from "../audit/index.ts";
import type { MailService } from "../mail/index.ts";
import { MINUTE_MS, serverVersion, type Clock, type Db, type JobScheduler, type Logger } from "../platform/index.ts";
import { systemUpdatesFetch, type UpdatesFetch } from "./github.ts";
import { createSystemctlUpdateHelper, type UpdateHelper } from "./helper.ts";
import { createUpdatesRepository } from "./repository.ts";
import { createUpdatesServiceWith, type NotifyAccount, type Reauthenticate, type UpdatesPaths, type UpdatesService } from "./service.ts";
import { DEFAULT_STATUS_FILE, DEFAULT_UPDATE_REQUESTS_DIR, SPOOL_FOLDER } from "./spool.ts";

export {
  CHECK_HEADERS,
  CHECK_TIMEOUT_MS,
  DOWNLOAD_HOSTS,
  downloadUrl,
  LATEST_RELEASE_URL,
  MAX_CHECK_BODY_BYTES,
  MAX_REDIRECTS,
  parseLatestRelease,
  type KeptRelease,
  type UpdatesFetch,
} from "./github.ts";
export {
  createSystemctlUpdateHelper,
  VERIFY_EXIT_REASONS,
  VERIFY_TIMEOUT_MS,
  VERIFY_UNIT,
  type SystemctlUpdateHelperDependencies,
  type UpdateHelper,
  type UpdateHelperOutcome,
} from "./helper.ts";
export {
  createCheckForUpdatesHandlers,
  createInstallUpdateHandlers,
  createUpdatesHandlers,
  type CheckForUpdatesRoutes,
  type InstallUpdateRoutes,
  type UpdatesRoutes,
} from "./routes.ts";
export { updateChecks, updateRequests, type UpdateCheckRow, type UpdateRequestRow } from "./schema.ts";
export {
  CHECK_INTERVAL_MS,
  CHECK_JITTER_MS,
  CHECK_NOW_LIMITS,
  FIRST_CHECK_MS,
  INSTALL_LIMIT,
  INSTALLER_COMMAND,
  notInstallableBecause,
  type NotifyAccount,
  type Reauthenticate,
  type UpdateOrigin,
  type UpdatesPaths,
  type UpdatesService,
} from "./service.ts";
export { DEFAULT_STATUS_FILE, DEFAULT_UPDATE_REQUESTS_DIR, UPDATE_REQUEST_FILE } from "./spool.ts";

/** The running release's root: `dist/` and `release-signing-keys/` sit in it, as `package.json` does for `serverVersion`. */
const releaseRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The config's switches, and the fakes tests put in place of GitHub, systemctl and the system's paths. */
export interface UpdatesOptions {
  /** `UPDATE_CHECK`: off, the server asks GitHub nothing at all. */
  readonly check: boolean;
  /** `UPDATE_FROM_UI`. */
  readonly fromUi: boolean;
  /** `globalThis.fetch` unless given. */
  readonly fetch?: UpdatesFetch;
  /** systemctl and the root update helper unless given. */
  readonly helper?: UpdateHelper;
  /** Production's unless given; the spool is `DATA_DIR/updates`. */
  readonly paths?: Partial<UpdatesPaths>;
  /** `process.arch` unless given. */
  readonly arch?: string;
  /** `serverVersion()` unless given. */
  readonly runningVersion?: string;
  readonly random?: () => number;
}

/** Off: no check, no install; what the CLI gets. */
export const updatesOff: UpdatesOptions = { check: false, fromUi: false };

export interface UpdatesDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly mail: Pick<MailService, "isConfigured" | "send">;
  /** The account holder's address, or null when the account has none. */
  readonly findAccountEmail: (accountId: string) => string | null;
  readonly reauthenticate: Reauthenticate;
  readonly dataDir: string;
  readonly options: UpdatesOptions;
}

/** Emails the admin about a finished update once SMTP is set; a failure is logged, never raised. */
function mailedNotices(
  mail: UpdatesDependencies["mail"],
  findAccountEmail: UpdatesDependencies["findAccountEmail"],
  logger: Logger,
): NotifyAccount {
  return (accountId, template) => {
    if (!mail.isConfigured()) return;
    const to = findAccountEmail(accountId);
    if (to === null) return;
    mail.send(template, to).catch((error: unknown) => {
      logger.warn(
        { kind: template.kind, accountId, err: error instanceof Error ? error.message : "unknown" },
        "an update notice could not be emailed",
      );
    });
  };
}

export function createUpdatesService({
  db,
  clock,
  logger,
  audit,
  mail,
  findAccountEmail,
  reauthenticate,
  dataDir,
  options,
}: UpdatesDependencies): UpdatesService {
  return createUpdatesServiceWith({
    checkEnabled: options.check,
    installEnabled: options.fromUi,
    runningVersion: options.runningVersion ?? serverVersion(),
    arch: options.arch ?? process.arch,
    repository: createUpdatesRepository(db),
    fetch: options.fetch ?? systemUpdatesFetch,
    helper: options.helper ?? createSystemctlUpdateHelper({ logger }),
    paths: {
      spoolDir: options.paths?.spoolDir ?? join(dataDir, SPOOL_FOLDER),
      requestsDir: options.paths?.requestsDir ?? DEFAULT_UPDATE_REQUESTS_DIR,
      statusFile: options.paths?.statusFile ?? DEFAULT_STATUS_FILE,
      trustedKeysDir: options.paths?.trustedKeysDir ?? join(releaseRoot, TRUSTED_KEYS_FOLDER),
    },
    reauthenticate,
    audit,
    notify: mailedNotices(mail, findAccountEmail, logger),
    clock,
    logger,
    ...(options.random === undefined ? {} : { random: options.random }),
  });
}

export const UPDATE_CHECK_JOB = "update-check";

/** Looks every minute whether the release check is due; registered only while `UPDATE_CHECK` is on. */
export function scheduleUpdateChecks(jobs: JobScheduler, updates: Pick<UpdatesService, "checkEnabled" | "checkIfDue">): void {
  if (!updates.checkEnabled) return;
  jobs.register({
    name: UPDATE_CHECK_JOB,
    intervalMs: MINUTE_MS,
    firstRunAfterMs: MINUTE_MS,
    run: async () => {
      await updates.checkIfDue();
    },
  });
}
