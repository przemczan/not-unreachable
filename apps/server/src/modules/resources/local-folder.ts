import { LOCAL_PATH_MAX_BYTES, type AllowFolderRefusal, type FolderRefusal, type UnavailableReason } from "@not-unreachable/contracts";
import {
  forbiddenRootOverlap,
  isSupportedFolderPath,
  touchesSystemFolder,
  withinAllowedPrefixes,
  type ForbiddenRootOverlap,
  type ForbiddenRoots,
} from "@not-unreachable/mount-helper/folder-access";
import { isAbsolute } from "node:path";
import { canonicalPath, fixRoot, type FixedRoot, type RealPath } from "../storage/index.ts";
import type { FolderKindRefusal, KindColumns, ResourceKindDefinition } from "./kinds.ts";
import type { ResourceRow } from "./schema.ts";

export { DEFAULT_MOUNT_ROOT, DEFAULT_RELEASE_DIR, type ForbiddenRoots } from "@not-unreachable/mount-helper/folder-access";

/**
 * `ALLOW_FOLDERS_FROM_UI=true` (deployment.md, "Allowing folders from the admin interface"): the
 * admin may allow a folder below one of these prefixes from the admin interface.
 */
export interface AllowFromUi {
  readonly allowedPrefixes: readonly string[];
}

export interface LocalFolderDependencies {
  readonly forbiddenRoots: ForbiddenRoots;
  /** `storage.fixRoot` unless given; tests pass one that answers `not-writable`. */
  readonly fixRoot?: (absolute: string) => Promise<FixedRoot>;
  /** Set only while `ALLOW_FOLDERS_FROM_UI` is on: a `not-writable` folder then says whether the admin can allow it here. */
  readonly allowFromUi?: AllowFromUi;
}

/** The pure rules of a local folder's path, before anything on disk is looked at. */
export type LocalFolderPathCheck =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly reason: "not-absolute" | "missing" | ForbiddenRootOverlap };

const SHELL_SAFE = /^[A-Za-z0-9_./-]+$/;

/** POSIX single quotes, only when the text holds anything outside `[A-Za-z0-9_./-]`. */
export function shellQuote(text: string): string {
  return SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

/** The exact line the admin runs on the host to let the service write to the folder. */
export function allowFolderCommand(realPath: string): string {
  return `sudo not-unreachable allow-folder ${shellQuote(realPath)}`;
}

/** The service's own folders as real paths, which may not exist yet. */
async function realRoots(roots: ForbiddenRoots): Promise<ForbiddenRoots> {
  return {
    dataDir: await canonicalPath(roots.dataDir),
    releaseDir: await canonicalPath(roots.releaseDir),
    mountRoot: await canonicalPath(roots.mountRoot),
  };
}

/**
 * The path rules the Add resource screen and `allow-folder` share: absolute, at most 4096 bytes, and
 * neither inside nor containing the data, release or mount folder (compared as real paths, which
 * may not exist yet). Looks at no folder's content and writes nothing.
 */
export async function checkLocalFolderPath(path: string, roots: ForbiddenRoots): Promise<LocalFolderPathCheck> {
  if (!isAbsolute(path)) return { ok: false, reason: "not-absolute" };
  // Linux has no path that long (PATH_MAX), so no such folder exists.
  if (Buffer.byteLength(path, "utf8") > LOCAL_PATH_MAX_BYTES) return { ok: false, reason: "missing" };
  const canonical = await canonicalPath(path);
  const overlap = forbiddenRootOverlap(canonical, await realRoots(roots));
  return overlap === undefined ? { ok: true, canonical } : { ok: false, reason: overlap };
}

/**
 * The rules only the admin interface applies, on the folder's real path, as the folder helper
 * applies them again as root: a path the drop-in can list, no system folder, below one of
 * `ALLOWED_FOLDER_PREFIXES`, and none of the service's own folders. Undefined when it passes.
 */
export async function adminInterfaceRefusal(
  realPath: string,
  allowFromUi: AllowFromUi,
  roots: ForbiddenRoots,
): Promise<AllowFolderRefusal | undefined> {
  if (!isSupportedFolderPath(realPath)) return "unsupported-path";
  if (touchesSystemFolder(realPath)) return "system-folder";
  if (!withinAllowedPrefixes(realPath, allowFromUi.allowedPrefixes)) return "outside-allowed-folders";
  return forbiddenRootOverlap(realPath, await realRoots(roots));
}

/** Whether the admin can allow a `not-writable` folder from the admin interface. */
async function allowableFromUi(realPath: string, dependencies: LocalFolderDependencies): Promise<boolean> {
  if (dependencies.allowFromUi === undefined) return false;
  return (await adminInterfaceRefusal(realPath, dependencies.allowFromUi, dependencies.forbiddenRoots)) === undefined;
}

/** A local folder's settings, checked: its real path and the columns to store, or why it was refused. */
export type LocalFolderCheck = { readonly ok: true; readonly realPath: RealPath; readonly columns: KindColumns } | FolderKindRefusal;

/** The path rules, then the folder itself: it exists, is a folder and the service can write to it. */
export async function checkLocalFolder(path: string, dependencies: LocalFolderDependencies): Promise<LocalFolderCheck> {
  const checked = await checkLocalFolderPath(path, dependencies.forbiddenRoots);
  if (!checked.ok) return refusal(checked.reason, null);
  // Only after the overlap checks: the write probe never lands in the service's own folders.
  const fixed = await (dependencies.fixRoot ?? fixRoot)(path);
  if (fixed.ok) return { ok: true, realPath: fixed.realPath, columns: { localPath: path } };
  if (fixed.reason !== "not-writable") return refusal(fixed.reason, null);
  return {
    ok: false,
    reason: "not-writable",
    command: allowFolderCommand(checked.canonical),
    allowFromUi: await allowableFromUi(checked.canonical, dependencies),
  };
}

function storedPath(row: ResourceRow): string {
  return row.localPath ?? "";
}

function refusal(reason: FolderRefusal, command: string | null): FolderKindRefusal {
  return { ok: false, reason, command, allowFromUi: false };
}

function unavailableReason(refused: Extract<FixedRoot, { ok: false }>): UnavailableReason {
  // A stored path is absolute; were it not, the folder is as good as missing.
  return refused.reason === "not-absolute" ? "missing" : refused.reason;
}

/** The `local` kind: a folder on the server. */
export function createLocalFolderKind(dependencies: LocalFolderDependencies): ResourceKindDefinition<"local"> {
  const fix = dependencies.fixRoot ?? fixRoot;

  return {
    kind: "local",
    prepare: async (input) => checkLocalFolder(input.localPath, dependencies),
    async prepareChange(row, change) {
      if (change.localPath === undefined) return { ok: true, fields: [] };
      const prepared = await checkLocalFolder(change.localPath, dependencies);
      if (!prepared.ok) return prepared;
      const same = change.localPath === row.localPath && prepared.realPath === row.rootRealpath && row.state === "available";
      return same ? { ok: true, fields: [] } : { ...prepared, fields: ["localPath"] };
    },
    async activate(row) {
      const fixed = await fix(storedPath(row));
      if (!fixed.ok) return { ok: false, reason: unavailableReason(fixed) };
      return fixed.realPath === row.rootRealpath ? { ok: true, realPath: fixed.realPath } : { ok: false, reason: "changed" };
    },
    deactivate: async () => undefined,
    async test(input) {
      const prepared = await checkLocalFolder(input.localPath, dependencies);
      if (prepared.ok) return { outcome: "ok" };
      return { outcome: "refused", reason: prepared.reason, command: prepared.command, allowFromUi: prepared.allowFromUi };
    },
    onStartup: async () => undefined,
    // A local folder comes back when the admin fixes it on the host and presses Retry.
    dueForRetry: () => [],
    present: (row) => ({ kind: "local", localPath: storedPath(row) }),
  };
}
