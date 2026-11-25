import type { AuditService } from "../audit/index.ts";
import type { Clock, Config, Db, Logger, Secrets } from "../platform/index.ts";
import type { FixedRoot } from "../storage/index.ts";
import {
  createAllowedFoldersService,
  type AllowedFoldersService,
  type NotifyFolderAllowed,
  type Reauthenticate,
} from "./allowed-folders.ts";
import { createSystemctlFolderHelper, type FolderHelper } from "./folder-helper.ts";
import { DEFAULT_FOLDER_REQUESTS_DIR } from "./folder-requests.ts";
import type { ResourceKindRegistry } from "./kinds.ts";
import { createLocalFolderKind, DEFAULT_MOUNT_ROOT, DEFAULT_RELEASE_DIR, type AllowFromUi, type ForbiddenRoots } from "./local-folder.ts";
import { DEFAULT_MOUNT_REQUESTS_DIR } from "./mount-requests.ts";
import { createMountRetries } from "./mount-retries.ts";
import { createSystemctlMountRunner, type MountRunner } from "./mount-runner.ts";
import { createResourcesRepository } from "./repository.ts";
import type { ResourceRow } from "./schema.ts";
import { createResourcesServiceWith, type ResourcesService } from "./service.ts";
import { createSmbShareKind } from "./smb-share.ts";

export {
  ALLOW_FOLDER_LIMIT,
  type AllowedFoldersService,
  type AllowFolderOrigin,
  type NotifyFolderAllowed,
  type Reauthenticate,
} from "./allowed-folders.ts";
export {
  ALLOW_FOLDER_TIMEOUT_MS,
  ALLOW_FOLDER_UNIT,
  createSystemctlFolderHelper,
  type FolderHelper,
  type FolderHelperOutcome,
  type SystemctlFolderHelperDependencies,
} from "./folder-helper.ts";
export { DEFAULT_FOLDER_REQUESTS_DIR, FOLDER_REQUEST_FILE } from "./folder-requests.ts";
export {
  FolderRefusedError,
  HomeNotFoundError,
  HomeRootNotSetError,
  ResourceInUseError,
  ResourceKindMismatchError,
  ResourceNameTakenError,
  ResourceNotFoundError,
  ResourceUnavailableError,
  SharePasswordRequiredError,
  ShareRefusedError,
  type ResourceInUse,
} from "./errors.ts";
export {
  definitionOf,
  type Activation,
  type FolderKindRefusal,
  type KindColumns,
  type KindFields,
  type KindRefusal,
  type PreparedChange,
  type PreparedSettings,
  type ResourceChangedField,
  type ResourceKindDefinition,
  type ResourceKindRegistry,
  type ShareKindRefusal,
} from "./kinds.ts";
export {
  adminInterfaceRefusal,
  allowFolderCommand,
  checkLocalFolder,
  checkLocalFolderPath,
  createLocalFolderKind,
  DEFAULT_MOUNT_ROOT,
  DEFAULT_RELEASE_DIR,
  shellQuote,
  type AllowFromUi,
  type ForbiddenRoots,
  type LocalFolderCheck,
  type LocalFolderDependencies,
  type LocalFolderPathCheck,
} from "./local-folder.ts";
export {
  DEFAULT_MOUNT_REQUESTS_DIR,
  deleteMountRequest,
  isCifsMount,
  MOUNT_INFO_PATH,
  parseMountInfo,
  writeMountRequest,
  type MountInfoEntry,
  type MountRequest,
} from "./mount-requests.ts";
export { createMountRetries, RESOURCE_MOUNT_RETRIES_JOB, scheduleResourceRetries, type MountRetries } from "./mount-retries.ts";
export {
  createSystemctlMountRunner,
  execFileResult,
  MOUNT_TIMEOUT_MS,
  MOUNT_UNIT_PREFIX,
  mountUnit,
  type ExecFileFunction,
  type ExecResult,
  type MountOutcome,
  type MountRunner,
  type SystemctlMountRunnerDependencies,
} from "./mount-runner.ts";
export { createAllowFolderHandlers, createResourcesHandlers, type AllowFolderRoutes, type ResourcesRoutes } from "./routes.ts";
export { homes, resources, type ResourceRow } from "./schema.ts";
export type { HomeRootChange, ResourcesService } from "./service.ts";
export { createSmbShareKind, type SmbShareDependencies } from "./smb-share.ts";
export {
  addFolderToDropIn,
  DEFAULT_DROP_IN_DIR,
  DROP_IN_FILE,
  dropInContent,
  foldersInDropIn,
  runSystemctl,
  SERVICE_UNIT,
  systemdPath,
  UnsupportedFolderPathError,
  type DropInChange,
  type SystemctlProgram,
} from "./systemd-dropin.ts";

/** Where the service's own folders are; the release, mount and request folders default to production's. */
export interface ResourceRootsOptions {
  readonly dataDir: string;
  readonly releaseDir?: string;
  readonly mountRoot?: string;
  /** Where the mount helper's request files are written (smb.md). */
  readonly mountRequestsDir?: string;
  /** `/proc/self/mountinfo` unless given; tests pass a file of their own. */
  readonly mountInfoPath?: string;
  /** `storage.fixRoot` unless given; tests pass one that answers `not-writable`. */
  readonly fixRoot?: (absolute: string) => Promise<FixedRoot>;
  /** systemctl and the root mount helper unless given; tests pass a fake that needs no root. */
  readonly mountRunner?: MountRunner;
  /** Set only while `ALLOW_FOLDERS_FROM_UI` is on ({@link allowFromUiOf}): an admin may allow folders from the admin interface. */
  readonly allowFromUi?: AllowFromUi;
  /** Where the folder helper's request file is written (deployment.md). */
  readonly folderRequestsDir?: string;
  /** systemctl and the root folder helper unless given; tests pass a fake that needs no root. */
  readonly folderHelper?: FolderHelper;
}

/** The config's `ALLOW_FOLDERS_FROM_UI` and `ALLOWED_FOLDER_PREFIXES` as resource options. */
export function allowFromUiOf(
  config: Pick<Config, "allowFoldersFromUi" | "allowedFolderPrefixes">,
): Pick<ResourceRootsOptions, "allowFromUi"> {
  return config.allowFoldersFromUi ? { allowFromUi: { allowedPrefixes: config.allowedFolderPrefixes } } : {};
}

export function forbiddenRootsOf(options: ResourceRootsOptions): ForbiddenRoots {
  return {
    dataDir: options.dataDir,
    releaseDir: options.releaseDir ?? DEFAULT_RELEASE_DIR,
    mountRoot: options.mountRoot ?? DEFAULT_MOUNT_ROOT,
  };
}

/** What the kinds need besides the folders: `smb` stores an encrypted password and audits failed mounts. */
export interface ResourceKindsDependencies {
  readonly secrets: Secrets | undefined;
  readonly audit: AuditService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly findResource: (id: string) => ResourceRow | undefined;
}

/** Every registered kind of resource: `local` folders and `smb` shares. */
export function createResourceKinds(options: ResourceRootsOptions, dependencies: ResourceKindsDependencies): ResourceKindRegistry {
  const forbiddenRoots = forbiddenRootsOf(options);
  const fixRoot = options.fixRoot === undefined ? {} : { fixRoot: options.fixRoot };
  const allowFromUi = options.allowFromUi === undefined ? {} : { allowFromUi: options.allowFromUi };
  return {
    local: createLocalFolderKind({ forbiddenRoots, ...fixRoot, ...allowFromUi }),
    smb: createSmbShareKind({
      secrets: dependencies.secrets,
      audit: dependencies.audit,
      logger: dependencies.logger,
      mountRoot: forbiddenRoots.mountRoot,
      requestsDir: options.mountRequestsDir ?? DEFAULT_MOUNT_REQUESTS_DIR,
      runner: options.mountRunner ?? createSystemctlMountRunner({ logger: dependencies.logger }),
      retries: createMountRetries(dependencies.clock),
      findResource: dependencies.findResource,
      ...(options.mountInfoPath === undefined ? {} : { mountInfoPath: options.mountInfoPath }),
      ...fixRoot,
    }),
  };
}

export interface ResourcesDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  /** The master key's secrets, which SMB passwords are encrypted under; the CLI has none. */
  readonly secrets: Secrets | undefined;
  readonly roots: ResourceRootsOptions;
  /** The kinds from {@link createResourceKinds} unless given. */
  readonly kinds?: ResourceKindRegistry;
}

export function createResourcesService({ db, clock, logger, audit, secrets, roots, kinds }: ResourcesDependencies): ResourcesService {
  const repository = createResourcesRepository(db);
  return createResourcesServiceWith({
    repository,
    kinds: kinds ?? createResourceKinds(roots, { secrets, audit, clock, logger, findResource: (id) => repository.findResource(id) }),
    audit,
    clock,
    logger,
  });
}

export interface AllowedFoldersModuleDependencies {
  readonly roots: ResourceRootsOptions;
  readonly reauthenticate: Reauthenticate;
  readonly audit: AuditService;
  readonly notifyFolderAllowed: NotifyFolderAllowed;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** Allowing folders from the admin interface; undefined unless `roots.allowFromUi` is set (the switch is on). */
export function createAllowedFolders({
  roots,
  reauthenticate,
  audit,
  notifyFolderAllowed,
  clock,
  logger,
}: AllowedFoldersModuleDependencies): AllowedFoldersService | undefined {
  if (roots.allowFromUi === undefined) return undefined;
  return createAllowedFoldersService({
    forbiddenRoots: forbiddenRootsOf(roots),
    allowFromUi: roots.allowFromUi,
    requestsDir: roots.folderRequestsDir ?? DEFAULT_FOLDER_REQUESTS_DIR,
    helper: roots.folderHelper ?? createSystemctlFolderHelper({ logger }),
    reauthenticate,
    audit,
    notifyFolderAllowed,
    clock,
    logger,
    ...(roots.fixRoot === undefined ? {} : { fixRoot: roots.fixRoot }),
  });
}
