/**
 * Letting the service write to a local folder (deployment.md, "Local folders"): the path rules and
 * the systemd drop-in that `sudo not-unreachable allow-folder` and the folder helper share, so the
 * command and the admin interface allow folders by the same code.
 *
 * `ProtectSystem=strict` makes the file system read-only for the service, so each local folder mapped
 * as a resource is listed in `ReadWritePaths=` of the drop-in `resources.conf`.
 *
 * It imports only `node:` built-ins: the folder helper runs as root and ships as built files alone.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

export const DEFAULT_DROP_IN_DIR = "/etc/systemd/system/not-unreachable.service.d";
export const DROP_IN_FILE = "resources.conf";
export const SERVICE_UNIT = "not-unreachable.service";

/** Where releases are installed (deployment.md); no local folder may overlap it. */
export const DEFAULT_RELEASE_DIR = "/opt/not-unreachable";
/** Where SMB shares are mounted (smb.md); no local folder may overlap it. */
export const DEFAULT_MOUNT_ROOT = "/srv/not-unreachable/mounts";

// --- Path rules ---------------------------------------------------------------------------------

/** Whether `path` is `root` or below it; both absolute and normalized. */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Whether either path is the other or below it. */
export function overlaps(path: string, other: string): boolean {
  return isWithin(path, other) || isWithin(other, path);
}

/** The service's own folders, which no local folder may be inside of, contain or equal. */
export interface ForbiddenRoots {
  readonly dataDir: string;
  readonly releaseDir: string;
  readonly mountRoot: string;
}

export type ForbiddenRootOverlap = "inside-data-directory" | "inside-release-directory" | "inside-mount-root";

/** Which of the service's own folders the folder overlaps; both sides compared as real paths. */
export function forbiddenRootOverlap(realPath: string, realRoots: ForbiddenRoots): ForbiddenRootOverlap | undefined {
  const forbidden: readonly (readonly [string, ForbiddenRootOverlap])[] = [
    [realRoots.dataDir, "inside-data-directory"],
    [realRoots.releaseDir, "inside-release-directory"],
    [realRoots.mountRoot, "inside-mount-root"],
  ];
  return forbidden.find(([root]) => overlaps(realPath, root))?.[1];
}

/**
 * Folders of the operating system the admin interface never allows, nor any folder inside or
 * holding one (so never `/` either). `allow-folder`, run as root on the server, doesn't apply them.
 */
export const SYSTEM_FOLDERS: readonly string[] = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/snap",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
];

/**
 * Whether the path is a system folder, inside one or holds one. Only tests pass other folders: their
 * temp dirs lie in /tmp, one of the system folders.
 */
export function touchesSystemFolder(path: string, systemFolders: readonly string[] = SYSTEM_FOLDERS): boolean {
  return systemFolders.some((folder) => overlaps(path, folder));
}

export const DEFAULT_ALLOWED_FOLDER_PREFIXES: readonly string[] = ["/srv", "/mnt"];

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** `ALLOWED_FOLDER_PREFIXES`'s comma-separated value as its prefixes. */
export function parseAllowedFolderPrefixes(value: string): string[] {
  return value
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix !== "");
}

/**
 * Why a prefix can't be one of `ALLOWED_FOLDER_PREFIXES`, as the operator reads it, or undefined
 * when it can: absolute and normalized, not `/`, and neither inside nor holding a system folder.
 */
export function allowedFolderPrefixProblem(prefix: string, systemFolders: readonly string[] = SYSTEM_FOLDERS): string | undefined {
  if (!isAbsolute(prefix) || hasControlCharacter(prefix)) return `${JSON.stringify(prefix)} is not an absolute path`;
  if (normalize(prefix) !== prefix || (prefix.length > 1 && prefix.endsWith("/"))) {
    return `${JSON.stringify(prefix)} is not a normalized path (no "." or ".." segments, doubled or trailing slashes)`;
  }
  if (prefix === "/") return "/ is never an allowed prefix";
  if (touchesSystemFolder(prefix, systemFolders)) return `${prefix} is or holds a system folder (${systemFolders.join(", ")})`;
  return undefined;
}

/** Whether the real path is one of the prefixes or below one; the prefixes are compared as written. */
export function withinAllowedPrefixes(realPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => isWithin(realPath, prefix));
}

// --- The drop-in --------------------------------------------------------------------------------

/** What `ProtectHome=` hides; a folder below one also needs `ProtectHome=tmpfs` and `BindPaths=`. */
const PROTECTED_HOME_ROOTS = ["/home", "/root", "/run/user"] as const;

const HEADER = [
  "# Managed by `not-unreachable allow-folder`, which rewrites this file: add folders with it, not by hand.",
  "# The local folders mapped as resources, which the service may write to (ProtectSystem=strict).",
];
const READ_WRITE = "ReadWritePaths=";

export interface DropInChange {
  readonly file: string;
  /** Every folder the drop-in now lists, sorted. */
  readonly folders: readonly string[];
  /** False when the folder was listed already and the file was left as it was. */
  readonly changed: boolean;
}

/** A folder whose path systemd's unit-file syntax can't carry safely here. */
export class UnsupportedFolderPathError extends Error {
  override readonly name = "UnsupportedFolderPathError";

  constructor() {
    super("The folder's path holds a backslash, a double quote or a control character, which a systemd drop-in can't list");
  }
}

/** Whether systemd's unit-file syntax can carry the path in the drop-in. */
export function isSupportedFolderPath(path: string): boolean {
  return !path.includes("\\") && !path.includes('"') && !hasControlCharacter(path);
}

/**
 * One path as a systemd value: `%` doubled (specifiers), and in double quotes when it holds white
 * space, a single quote or a colon, which systemd would otherwise split on, read as a quote or, in
 * `BindPaths=`, read as the start of the destination.
 */
export function systemdPath(path: string): string {
  if (!isSupportedFolderPath(path)) throw new UnsupportedFolderPathError();
  const escaped = path.replaceAll("%", "%%");
  return /[\s':]/u.test(path) ? `"${escaped}"` : escaped;
}

function parsePath(value: string): string {
  const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return unquoted.replaceAll("%%", "%");
}

/** The folders a drop-in this module wrote lists, from its `ReadWritePaths=` lines. */
export function foldersInDropIn(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.startsWith(READ_WRITE))
    .map((line) => parsePath(line.slice(READ_WRITE.length).trim()))
    .filter((path) => path !== "");
}

function underProtectedHome(path: string): boolean {
  return PROTECTED_HOME_ROOTS.some((root) => isWithin(path, root));
}

/** The whole drop-in for these folders. */
export function dropInContent(folders: readonly string[]): string {
  const sorted = [...new Set(folders)].toSorted();
  const hidden = sorted.filter(underProtectedHome);
  const lines = [...HEADER, "[Service]", ...sorted.map((folder) => `${READ_WRITE}${systemdPath(folder)}`)];
  if (hidden.length > 0) {
    lines.push(
      "# Folders under /home, /root or /run/user, which ProtectHome=yes hides: an empty tmpfs there instead,",
      "# with each folder bound back in.",
      "ProtectHome=tmpfs",
      ...hidden.map((folder) => `BindPaths=${systemdPath(folder)}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function readIfThere(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Writes a temp file in the same folder, syncs it, then renames it over the file: never half-written. */
async function writeAtomically(dir: string, file: string, content: string): Promise<void> {
  const temp = join(dir, `.${DROP_IN_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o644);
  try {
    await handle.writeFile(content, "utf8");
    // The umask may have narrowed the mode; systemd needs to read the file.
    await handle.chmod(0o644);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp);
    throw error;
  }
  const folder = await open(dir, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

/** The folders the drop-in in `dir` lists; none when there is no drop-in yet. */
export async function foldersListedIn(dir: string): Promise<string[]> {
  return foldersInDropIn((await readIfThere(join(dir, DROP_IN_FILE))) ?? "");
}

/** The first of `folders`, other than the path itself, that the path lies inside or holds. */
export function overlappingFolder(path: string, folders: readonly string[]): string | undefined {
  return folders.find((folder) => folder !== path && overlaps(path, folder));
}

/** Adds the folder to the drop-in in `dir` (made 0755 if missing); a folder already listed changes nothing. */
export async function addFolderToDropIn(dir: string, folder: string): Promise<DropInChange> {
  const file = join(dir, DROP_IN_FILE);
  const existing = await readIfThere(file);
  const folders = [...new Set([...foldersInDropIn(existing ?? ""), folder])].toSorted();
  const content = dropInContent(folders);
  if (existing === content) return { file, folders, changed: false };
  // The umask may narrow a new folder's mode; systemd reads it as root, admins list it.
  if ((await mkdir(dir, { recursive: true, mode: 0o755 })) !== undefined) await chmod(dir, 0o755);
  await writeAtomically(dir, file, content);
  return { file, folders, changed: true };
}
