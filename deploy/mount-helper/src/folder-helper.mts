/**
 * The folder helper (deployment.md, "Local folders"): allows a local folder from the admin interface,
 * as `sudo not-unreachable allow-folder` does from a shell. systemd starts it as
 * `not-unreachable-allow-folder.service`, which polkit lets the service user start, and nothing else,
 * only while `ALLOW_FOLDERS_FROM_UI=true` (the CLI wrapper's `allow-folders-from-ui`).
 *
 * Trust boundary: everything the service user can touch is hostile. That is the request file, the
 * directory it lies in and the path in it. So the helper reads its switch and the allowed prefixes
 * from root's config.env, never from the request; opens the request with O_NOFOLLOW and checks the
 * descriptor it read from; resolves the path with realpath and checks the real path alone against
 * the rules folder-access.mts shares with `allow-folder`, plus the allowed prefixes, the system
 * folders and the folders the drop-in lists already, which `allow-folder` doesn't apply; runs programs only through execFile with an argument
 * array; and writes nothing but the root-owned drop-in. The result travels back as the exit code.
 *
 * It imports only `node:` built-ins, `folder-access.mts` and `request-file.mts`, so the built files
 * are those three and nothing else.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  addFolderToDropIn,
  allowedFolderPrefixProblem,
  DEFAULT_ALLOWED_FOLDER_PREFIXES,
  DEFAULT_DROP_IN_DIR,
  DEFAULT_MOUNT_ROOT,
  DEFAULT_RELEASE_DIR,
  foldersListedIn,
  forbiddenRootOverlap,
  isSupportedFolderPath,
  overlappingFolder,
  parseAllowedFolderPrefixes,
  SERVICE_UNIT,
  SYSTEM_FOLDERS,
  touchesSystemFolder,
  withinAllowedPrefixes,
  type ForbiddenRootOverlap,
} from "./folder-access.mts";
import { errorCode, inRequestDirectory, lookUpAccount, readRequest, RequestFileError, type Account } from "./request-file.mts";

/** The exit codes; the server reads them from `ExecMainStatus` and maps each to a reason. */
export const EXIT_CODES = {
  /** The folder is in the drop-in, systemd reloaded, and the service's restart is scheduled. */
  ok: 0,
  /** Anything unexpected: no service user, an I/O error, the drop-in can't be written. */
  internal: 1,
  /** Not `allow`. */
  usage: 2,
  /** No request file. */
  requestMissing: 3,
  /** The request is a symlink, not a regular file, not the service user's, not 0600, or 8 KiB or more; or its directory isn't one. */
  requestRefused: 4,
  /** The request isn't UTF-8 JSON, has missing or unknown keys, or its path isn't a string of 1 to 4096 bytes without NUL. */
  requestInvalid: 5,
  /** `ALLOW_FOLDERS_FROM_UI` is not `true`. */
  switchOff: 6,
  /** config.env isn't root's regular file, is writable by group or others, can't be read, or holds a bad prefix or DATA_DIR. */
  configRefused: 7,
  /** The path is not absolute. */
  notAbsolute: 20,
  /** Nothing is there. */
  missing: 21,
  /** Something other than a folder is there. */
  notAFolder: 22,
  /** The folder is, holds or lies inside the data folder. */
  insideDataDirectory: 23,
  /** The folder is, holds or lies inside the releases' folder. */
  insideReleaseDirectory: 24,
  /** The folder is, holds or lies inside the SMB mount root. */
  insideMountRoot: 25,
  /** The folder lies outside every `ALLOWED_FOLDER_PREFIXES`. */
  outsideAllowedFolders: 26,
  /** The folder is, holds or lies inside a system folder. */
  systemFolder: 27,
  /** The folder's path holds a character a systemd drop-in can't list. */
  unsupportedPath: 28,
  /** The folder lies inside or holds a folder the drop-in lists already. */
  overlapsAllowedFolder: 29,
  /** `systemctl daemon-reload` or `systemd-run` failed. */
  systemdFailed: 30,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** The shape of `promisify(execFile)`: resolves when the program exits 0, rejects otherwise. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly timeout: number },
) => Promise<unknown>;

/** What the helper works with; production passes fixed constants only, tests point it at temp dirs. */
export interface HelperDependencies {
  readonly requestDir: string;
  readonly configFile: string;
  readonly dropInDir: string;
  readonly releaseDir: string;
  readonly mountRoot: string;
  /** Who must own config.env: root, except in unit tests. */
  readonly rootUid: number;
  /** SYSTEM_FOLDERS, except in unit tests, whose temp dirs lie in /tmp. */
  readonly systemFolders: readonly string[];
  readonly serviceUser: () => Promise<Account>;
  readonly execFile: ExecFile;
  readonly writeError: (line: string) => void;
}

export const REQUEST_FILE = "allow-folder.json";
export const DEFAULT_DATA_DIR = "/var/lib/not-unreachable";
const MAX_PATH_BYTES = 4096;
const MAX_CONFIG_BYTES = 65_536;
// Short of systemd's TimeoutStartSec=30s.
const EXEC_OPTIONS = { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, timeout: 25_000 } as const;
// Long enough for the server to answer the request and write its audit entry before it is stopped.
const RESTART_DELAY = "3s";

class Failure extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- config.env ---------------------------------------------------------------------------------

/** The settings of config.env the checks use, once the switch is on. */
export interface FolderConfig {
  readonly prefixes: readonly string[];
  readonly dataDir: string;
}

function refusedConfig(message: string): Failure {
  return new Failure(EXIT_CODES.configRefused, message);
}

function unquoted(value: string): string {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value;
}

/**
 * `KEY=VALUE` lines, the subset of systemd's EnvironmentFile= that config.env uses: blank lines and
 * lines starting with `#` or `;` skipped, keys and values trimmed, one pair of matching quotes
 * stripped. A later line wins, as with systemd.
 */
export function parseEnvironmentFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const equals = line.indexOf("=");
    if (line === "" || line.startsWith("#") || line.startsWith(";") || equals <= 0) continue;
    values.set(line.slice(0, equals).trim(), unquoted(line.slice(equals + 1).trim()));
  }
  return values;
}

/** The switch: on only when exactly `true`. */
export function allowsFoldersFromUi(values: ReadonlyMap<string, string>): boolean {
  return values.get("ALLOW_FOLDERS_FROM_UI") === "true";
}

/** The prefixes and the data folder; a bad prefix or DATA_DIR refuses every folder. */
export function folderConfig(values: ReadonlyMap<string, string>, systemFolders: readonly string[] = SYSTEM_FOLDERS): FolderConfig {
  const listed = parseAllowedFolderPrefixes(values.get("ALLOWED_FOLDER_PREFIXES") ?? "");
  const prefixes = listed.length === 0 ? DEFAULT_ALLOWED_FOLDER_PREFIXES : listed;
  for (const prefix of prefixes) {
    const problem = allowedFolderPrefixProblem(prefix, systemFolders);
    if (problem !== undefined) throw refusedConfig(`ALLOWED_FOLDER_PREFIXES: ${problem}`);
  }
  const written = values.get("DATA_DIR") ?? "";
  const dataDir = written === "" ? DEFAULT_DATA_DIR : written;
  if (!isAbsolute(dataDir)) throw refusedConfig(`DATA_DIR ${JSON.stringify(dataDir)} is not an absolute path`);
  return { prefixes, dataDir };
}

/** Reads config.env through one descriptor: root's regular file, not writable by group or others. */
async function readConfig(path: string, rootUid: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw refusedConfig(`${path} can't be opened`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.uid !== rootUid || (stats.mode & 0o022) !== 0 || stats.size >= MAX_CONFIG_BYTES) {
      throw refusedConfig(`${path} is not root's regular file under 64 KiB, unwritable by group and others`);
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES);
    let length = 0;
    while (length < MAX_CONFIG_BYTES) {
      const { bytesRead } = await handle.read(buffer, length, MAX_CONFIG_BYTES - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length >= MAX_CONFIG_BYTES) throw refusedConfig(`${path} is 64 KiB or more`);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw refusedConfig(`${path} can't be read`);
  } finally {
    await handle.close();
  }
}

// --- The request --------------------------------------------------------------------------------

function invalid(message: string): Failure {
  return new Failure(EXIT_CODES.requestInvalid, message);
}

/** The path the admin typed, as the request holds it; the checks on what it names come later. */
export function parseFolderRequest(content: Uint8Array): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw invalid("the request is not UTF-8 JSON");
  }
  if (!isRecord(value)) throw invalid("the request is not a JSON object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "path") throw invalid("the request has missing or unknown fields");
  const path = value["path"];
  if (typeof path !== "string" || path === "" || Buffer.byteLength(path) > MAX_PATH_BYTES || path.includes("\0")) {
    throw invalid("the request's path is not valid");
  }
  return path;
}

async function readFolderRequest(dependencies: HelperDependencies): Promise<string> {
  const account = await dependencies.serviceUser();
  // The server deletes the request once the unit ends: unlinking it here would take CAP_DAC_OVERRIDE
  // on the service user's 0700 folder.
  const content = await inRequestDirectory(dependencies.requestDir, (pinned) => readRequest(join(pinned, REQUEST_FILE), account.uid));
  if (content === undefined) throw new Failure(EXIT_CODES.requestMissing, "no request directory");
  return parseFolderRequest(content);
}

// --- The folder ---------------------------------------------------------------------------------

const OVERLAP_EXIT_CODES: Readonly<Record<ForbiddenRootOverlap, ExitCode>> = {
  "inside-data-directory": EXIT_CODES.insideDataDirectory,
  "inside-release-directory": EXIT_CODES.insideReleaseDirectory,
  "inside-mount-root": EXIT_CODES.insideMountRoot,
};

/** A forbidden root as a real path when it exists, so a symlinked one still matches; as written otherwise. */
async function realRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return path;
    throw error;
  }
}

/** The real path of the folder, once every rule allows it. */
async function checkFolder(path: string, config: FolderConfig, dependencies: HelperDependencies): Promise<string> {
  const shown = JSON.stringify(path);
  if (!isAbsolute(path)) throw new Failure(EXIT_CODES.notAbsolute, `${shown} is not an absolute path`);
  let realPath: string;
  try {
    realPath = await realpath(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw new Failure(EXIT_CODES.missing, `${shown} does not exist`);
    throw error;
  }
  // Symlinks are followed: every check from here on is on the real path, and so is the drop-in.
  const real = JSON.stringify(realPath);
  // lstat: a symlink swapped in since realpath is not a folder.
  if (!(await lstat(realPath)).isDirectory()) throw new Failure(EXIT_CODES.notAFolder, `${real} is not a folder`);
  if (!isSupportedFolderPath(realPath)) throw new Failure(EXIT_CODES.unsupportedPath, `${real} holds a character a drop-in can't list`);
  if (touchesSystemFolder(realPath, dependencies.systemFolders)) {
    throw new Failure(EXIT_CODES.systemFolder, `${real} is, holds or lies inside a system folder`);
  }
  if (!withinAllowedPrefixes(realPath, config.prefixes)) {
    throw new Failure(EXIT_CODES.outsideAllowedFolders, `${real} is outside ALLOWED_FOLDER_PREFIXES (${config.prefixes.join(",")})`);
  }
  const overlap = forbiddenRootOverlap(realPath, {
    dataDir: await realRoot(config.dataDir),
    releaseDir: await realRoot(dependencies.releaseDir),
    mountRoot: await realRoot(dependencies.mountRoot),
  });
  if (overlap !== undefined) throw new Failure(OVERLAP_EXIT_CODES[overlap], `${real} overlaps a folder of the service (${overlap})`);
  await refuseOverlapWithAllowedFolders(realPath, dependencies.dropInDir);
  return realPath;
}

/** A listed folder's real path now, or the path as written when it can't be resolved. */
async function realPathOrAsWritten(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The service can write inside every folder the drop-in lists, so it could swap a folder below one
 * for a symlink, and systemd follows symlinks when it applies the drop-in at the next start. A folder
 * inside a listed one, or holding one, would let it open any path that way. Each listed folder is
 * compared as written, as systemd reads it, and by its real path now.
 */
async function refuseOverlapWithAllowedFolders(realPath: string, dropInDir: string): Promise<void> {
  const listed = await foldersListedIn(dropInDir);
  const overlapping = overlappingFolder(realPath, [...listed, ...(await Promise.all(listed.map(realPathOrAsWritten)))]);
  if (overlapping !== undefined) {
    throw new Failure(
      EXIT_CODES.overlapsAllowedFolder,
      `${JSON.stringify(realPath)} lies inside or holds ${JSON.stringify(overlapping)}, which the service may write to already`,
    );
  }
}

// --- systemd ------------------------------------------------------------------------------------

/** `systemd-run`'s arguments for restarting the service a few seconds from now. */
export const RESTART_ARGUMENTS: readonly string[] = [
  "--quiet",
  "--collect",
  "--no-block",
  `--on-active=${RESTART_DELAY}`,
  "--description=not-unreachable: restart after allowing a folder",
  "/usr/bin/systemctl",
  "restart",
  SERVICE_UNIT,
];

async function run(dependencies: HelperDependencies, what: string, file: string, args: readonly string[]): Promise<void> {
  try {
    await dependencies.execFile(file, args, EXEC_OPTIONS);
  } catch {
    throw new Failure(EXIT_CODES.systemdFailed, `${what} failed`);
  }
}

/**
 * Reloads systemd, then has a timer restart the service: restarting it now would stop it before it
 * answers, and would stop the `systemctl start` that waits for this unit, which runs in its cgroup.
 * Like `allow-folder`, it reloads and restarts even when the folder was listed already.
 */
async function applyDropIn(dependencies: HelperDependencies): Promise<void> {
  await run(dependencies, "systemctl daemon-reload", "systemctl", ["daemon-reload"]);
  await run(dependencies, "scheduling the restart with systemd-run", "systemd-run", RESTART_ARGUMENTS);
}

// --- The verb -----------------------------------------------------------------------------------

async function allow(dependencies: HelperDependencies): Promise<void> {
  const content = await readConfig(dependencies.configFile, dependencies.rootUid);
  const values = parseEnvironmentFile(content);
  if (!allowsFoldersFromUi(values)) {
    throw new Failure(EXIT_CODES.switchOff, "ALLOW_FOLDERS_FROM_UI is not true in config.env");
  }
  const config = folderConfig(values, dependencies.systemFolders);
  const path = await readFolderRequest(dependencies);
  const realPath = await checkFolder(path, config, dependencies);
  await addFolderToDropIn(dependencies.dropInDir, realPath);
  await applyDropIn(dependencies);
}

function exitCodeOf(error: unknown): ExitCode {
  if (error instanceof Failure) return error.exitCode;
  if (error instanceof RequestFileError) return error.problem === "missing" ? EXIT_CODES.requestMissing : EXIT_CODES.requestRefused;
  return EXIT_CODES.internal;
}

/** Runs `allow` and answers the exit code; a failure writes one line naming the reason. */
export async function runHelper(argv: readonly string[], dependencies: HelperDependencies): Promise<ExitCode> {
  if (argv.length !== 1 || argv[0] !== "allow") {
    dependencies.writeError("usage: folder-helper.mjs allow");
    return EXIT_CODES.usage;
  }
  try {
    await allow(dependencies);
    return EXIT_CODES.ok;
  } catch (error) {
    // Paths are JSON-quoted in the helper's own messages; an error from Node may hold one raw.
    const message = error instanceof Error ? error.message.replaceAll(/[\r\n]/gu, " ") : "unknown error";
    dependencies.writeError(`allow: ${message}`);
    return exitCodeOf(error);
  }
}

if (import.meta.main) {
  process.exitCode = await runHelper(process.argv.slice(2), {
    requestDir: "/run/not-unreachable/folder-requests",
    configFile: "/etc/not-unreachable/config.env",
    dropInDir: DEFAULT_DROP_IN_DIR,
    releaseDir: DEFAULT_RELEASE_DIR,
    mountRoot: DEFAULT_MOUNT_ROOT,
    rootUid: 0,
    systemFolders: SYSTEM_FOLDERS,
    serviceUser: async () => lookUpAccount(await readFile("/etc/passwd", "utf8"), "not-unreachable"),
    execFile: promisify(execFile),
    writeError: (line) => process.stderr.write(`${line}\n`),
  });
}
