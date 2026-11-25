import type { AccountsService } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import { MINUTE_MS, type Clock, type Db, type JobScheduler, type Logger } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import type { SettingsService } from "../settings/index.ts";
import { createUploadsRepository } from "./repository.ts";
import { createFilesServiceWith, type FilesService, type FreeSpaceProbes } from "./service.ts";
import { createStagingArea } from "./staging.ts";
import { createUploadsGateway, uploadsConfigstore, type UploadsGateway } from "./uploads.ts";

export { attachmentDisposition, DOWNLOAD_CSP, sendContained, type DownloadStart } from "./download.ts";
export { mapped as mappedFileRefusals } from "./problems.ts";
export { createFilesHandlers, type FilesRoutes } from "./routes.ts";
export { uploads, type UploadRow } from "./schema.ts";
export {
  listEntries,
  TEMP_FILE_MAX_AGE_MS,
  UPLOAD_EXPIRY_MS,
  type CleanupResult,
  type EntriesRequest,
  type FilesPlace,
  type FilesService,
  type FreeSpaceProbes,
  type UploadCaller,
} from "./service.ts";
export type { UploadsGateway } from "./uploads.ts";

export const UPLOADS_CLEANUP_JOB = "uploads-cleanup";

export interface FilesDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly settings: SettingsService;
  readonly accounts: Pick<AccountsService, "findById">;
  readonly resources: Pick<ResourcesService, "rootFor" | "homeFor">;
  /** `DATA_DIR/uploads`, where chunks are staged; made (0700) on first use. */
  readonly stagingDir: string;
  /** `statfs` of the staging folder and `storage.freeSpace` unless given; tests fake them. */
  readonly freeSpace?: Partial<FreeSpaceProbes>;
}

export interface FilesModule {
  readonly files: FilesService;
  readonly uploads: UploadsGateway;
}

export function createFilesModule({
  db,
  clock,
  logger,
  audit,
  settings,
  accounts,
  resources,
  stagingDir,
  freeSpace,
}: FilesDependencies): FilesModule {
  const repository = createUploadsRepository(db);
  const staging = createStagingArea(stagingDir, uploadsConfigstore(repository));
  const files = createFilesServiceWith({
    repository,
    staging,
    resources,
    accounts,
    settings,
    audit,
    clock,
    logger,
    ...(freeSpace === undefined ? {} : { freeSpace }),
  });
  return { files, uploads: createUploadsGateway({ service: files, staging, clock, logger }) };
}

/** The uploads cleanup (threat model, T7): at startup, then hourly. */
export function scheduleUploadsCleanup(jobs: JobScheduler, files: Pick<FilesService, "cleanup">): void {
  jobs.register({
    name: UPLOADS_CLEANUP_JOB,
    intervalMs: 60 * MINUTE_MS,
    run: async () => {
      await files.cleanup();
    },
  });
}
