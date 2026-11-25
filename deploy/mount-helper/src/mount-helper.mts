/**
 * The SMB mount helper (smb.md, "What happens underneath"): with the folder helper, the only code of
 * not-unreachable that runs as root. systemd starts it as `not-unreachable-mount@<id>.service`, which polkit lets the service
 * user start and stop and nothing else.
 *
 * Trust boundary: everything the service user can touch is hostile. That is the instance name
 * (`<id>`), the request file and the directory it lies in. So the helper derives every path itself
 * from fixed constants and a UUID, opens the request with O_NOFOLLOW and checks the descriptor it
 * read from, validates every field against strict patterns, sets every mount option itself, runs
 * programs only through execFile with an argument array, and never writes into a directory the
 * service user controls: the result travels back as the exit code alone.
 *
 * It imports only `node:` built-ins and `request-file.mts`, which reads the request as the folder
 * helper does, so the built files are those two and nothing else.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorCode, inRequestDirectory, lookUpAccount, readRequest, RequestFileError, type Account } from "./request-file.mts";

export { lookUpAccount, type Account };

/** The exit codes; the server reads them from `ExecMainStatus` and maps 10–13 to a reason. */
export const EXIT_CODES = {
  /** Mounted, or unmounted. */
  ok: 0,
  /** Anything unexpected: a bad credentials directory or mount root, no service user, an I/O error. */
  internal: 1,
  /** Not `mount <uuid>` or `unmount <uuid>`. */
  usage: 2,
  /** No request file for the id. */
  requestMissing: 3,
  /** The request is a symlink, not a regular file, not the service user's, not 0600, or 8 KiB or more. */
  requestRefused: 4,
  /** The request isn't JSON, has missing or unknown fields, or a field fails its pattern. */
  requestInvalid: 5,
  /** The server refused the user name or password. */
  auth: 10,
  /** The server couldn't be resolved or reached. */
  unreachable: 11,
  /** The server has no such share or folder. */
  noShare: 12,
  /** The server doesn't speak the protocol version or encryption asked for. */
  notSupported: 13,
  /** mount.cifs failed for another reason. */
  mountFailed: 14,
  /** umount failed. */
  unmountFailed: 15,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** The shape of `promisify(execFile)`: resolves when the program exits 0, rejects with `code` and `stderr` otherwise. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly timeout: number },
) => Promise<unknown>;

/** What the helper works with; production passes fixed constants only, tests point it at temp dirs. */
export interface HelperDependencies {
  readonly requestDir: string;
  readonly credentialsDir: string;
  readonly mountRoot: string;
  /** Who must own the credentials directory and the mount root: root, except in unit tests. */
  readonly rootUid: number;
  readonly serviceUser: () => Promise<Account>;
  readonly mountInfo: () => Promise<string>;
  readonly execFile: ExecFile;
  readonly writeError: (line: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Short of systemd's TimeoutStartSec=30s, so the finally blocks still delete the credentials file.
const EXEC_OPTIONS = { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, timeout: 25_000 } as const;

class Failure extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

// --- The request -------------------------------------------------------------------------------

const VERSIONS = ["3.1.1", "3.0", "2.1"] as const;
const REQUEST_KEYS = ["host", "share", "subfolder", "username", "password", "domain", "vers", "seal"];

export interface ShareRequest {
  readonly host: string;
  readonly share: string;
  readonly subfolder: string;
  readonly username: string;
  readonly password: string;
  readonly domain: string;
  readonly vers: (typeof VERSIONS)[number];
  readonly seal: boolean;
}

const HOST_NAME = /^[A-Za-z0-9.-]{1,253}$/u;
// IPv6 without brackets or a zone id: a zone id could hold any character.
const IPV6 = /^[0-9A-Fa-f:.]+$/u;
const SHARE = /^[^/\\:*?"<>|,=]{1,80}$/u;
const SEGMENT = /^[^/\\:*?"<>|,=]{1,255}$/u;
const ACCOUNT_NAME = /^[^,=\n\r]{1,104}$/u;

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

function isPathName(text: string, pattern: RegExp): boolean {
  return pattern.test(text) && !hasControlCharacter(text) && text !== "." && text !== "..";
}

const VALIDATORS: Readonly<Record<string, (text: string) => boolean>> = {
  host: (host) => HOST_NAME.test(host) || (isIP(host) === 6 && IPV6.test(host)),
  share: (share) => isPathName(share, SHARE),
  // Splitting keeps empty segments, so a leading, trailing or doubled slash fails too.
  subfolder: (path) => path === "" || (path.length <= 1024 && path.split("/").every((segment) => isPathName(segment, SEGMENT))),
  username: (name) => ACCOUNT_NAME.test(name) && !hasControlCharacter(name),
  domain: (name) => name === "" || (ACCOUNT_NAME.test(name) && !hasControlCharacter(name)),
  // It goes only into the credentials file, one line per field.
  password: (password) => password.length >= 1 && password.length <= 256 && !/[\n\r\0]/u.test(password),
};

function isVersion(value: unknown): value is ShareRequest["vers"] {
  return VERSIONS.some((version) => version === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Failure {
  return new Failure(EXIT_CODES.requestInvalid, message);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  const valid = VALIDATORS[key];
  if (typeof value !== "string" || valid === undefined || !valid(value)) throw invalid(`the request's ${key} is not valid`);
  return value;
}

/** Parses and validates the request; error messages name the field, never its value. */
export function parseRequest(content: Uint8Array): ShareRequest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw invalid("the request is not UTF-8 JSON");
  }
  if (!isRecord(value)) throw invalid("the request is not a JSON object");
  const keys = Object.keys(value);
  if (keys.length !== REQUEST_KEYS.length || !keys.every((key) => REQUEST_KEYS.includes(key))) {
    throw invalid("the request has missing or unknown fields");
  }
  const seal = value["seal"];
  const vers = value["vers"];
  if (typeof seal !== "boolean") throw invalid("the request's seal is not valid");
  if (!isVersion(vers)) throw invalid("the request's vers is not valid");
  return {
    host: stringField(value, "host"),
    share: stringField(value, "share"),
    subfolder: stringField(value, "subfolder"),
    username: stringField(value, "username"),
    password: stringField(value, "password"),
    domain: stringField(value, "domain"),
    vers,
    // SMB 2.1 has no encryption.
    seal: seal && vers !== "2.1",
  };
}

// --- Root-owned directories and files ------------------------------------------------------------

/** Refuses a symlink, a directory someone else owns, and one with another mode (or, without one, writable by others). */
async function requireDirectory(path: string, ownerUid: number, mode?: number): Promise<void> {
  const stats = await lstat(path);
  const modeOk = mode === undefined ? (stats.mode & 0o022) === 0 : (stats.mode & 0o7777) === mode;
  if (!stats.isDirectory() || stats.uid !== ownerUid || !modeOk) {
    throw new Failure(EXIT_CODES.internal, `${path} is not a root-owned directory with the expected mode`);
  }
}

async function makeDirectory(path: string, mode: number): Promise<void> {
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

async function writeCredentials(path: string, request: ShareRequest): Promise<void> {
  await removeFile(path);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const domain = request.domain === "" ? "" : `domain=${request.domain}\n`;
    await handle.writeFile(`username=${request.username}\npassword=${request.password}\n${domain}`);
  } finally {
    await handle.close();
  }
}

/** `mount.cifs`'s arguments; every option is the helper's own. */
export function mountArguments(request: ShareRequest, mountPoint: string, credentials: string, account: Account): string[] {
  const ipv6 = isIP(request.host) === 6;
  const subfolder = request.subfolder === "" ? "" : `/${request.subfolder}`;
  const unc = `//${ipv6 ? `[${request.host}]` : request.host}/${request.share}${subfolder}`;
  const options = [
    `vers=${request.vers}`,
    "sign",
    ...(request.seal ? ["seal"] : []),
    `credentials=${credentials}`,
    `uid=${account.uid}`,
    `gid=${account.gid}`,
    "forceuid",
    "forcegid",
    "file_mode=0640",
    "dir_mode=0750",
    "nosuid",
    "nodev",
    "noexec",
    "nounix",
    "soft",
    "echo_interval=30",
    "iocharset=utf8",
    ...(ipv6 ? [`ip=${request.host}`] : []),
  ];
  return [unc, mountPoint, "-o", options.join(",")];
}

const ERRNO_EXIT_CODES = new Map<number, ExitCode>([
  ...[1, 13, 126, 127, 128, 129].map((errno) => [errno, EXIT_CODES.auth] as const),
  ...[101, 104, 110, 111, 112, 113].map((errno) => [errno, EXIT_CODES.unreachable] as const),
  ...[2, 6, 20].map((errno) => [errno, EXIT_CODES.noShare] as const),
  ...[93, 95].map((errno) => [errno, EXIT_CODES.notSupported] as const),
]);

/** Names a mount.cifs failure from its `mount error(N)` line. */
export function mountFailure(error: unknown): Failure {
  if (typeof error === "object" && error !== null && "killed" in error && error.killed === true) {
    return new Failure(EXIT_CODES.unreachable, "mount.cifs timed out");
  }
  const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  const errno = /mount error\((\d+)\)/u.exec(stderr)?.[1];
  if (errno !== undefined) {
    return new Failure(ERRNO_EXIT_CODES.get(Number(errno)) ?? EXIT_CODES.mountFailed, `mount.cifs failed: mount error(${errno})`);
  }
  if (/could not resolve address/iu.test(stderr)) return new Failure(EXIT_CODES.unreachable, "mount.cifs could not resolve the host");
  return new Failure(EXIT_CODES.mountFailed, "mount.cifs failed");
}

// --- The two verbs -------------------------------------------------------------------------------

async function mount(id: string, dependencies: HelperDependencies): Promise<void> {
  const account = await dependencies.serviceUser();
  const content = await inRequestDirectory(dependencies.requestDir, async (pinned) => {
    const requestPath = join(pinned, `${id}.json`);
    try {
      return await readRequest(requestPath, account.uid);
    } finally {
      // Unlinking a symlink removes the link, not its target. A directory put there can't be
      // unlinked; the app deletes whatever is left.
      await unlink(requestPath).catch(() => undefined);
    }
  });
  if (content === undefined) throw new Failure(EXIT_CODES.requestMissing, "no request directory");
  const request = parseRequest(content);

  await requireDirectory(dependencies.mountRoot, dependencies.rootUid);
  await makeDirectory(dependencies.credentialsDir, 0o700);
  await requireDirectory(dependencies.credentialsDir, dependencies.rootUid, 0o700);
  const credentials = join(dependencies.credentialsDir, `${id}.cred`);
  const mountPoint = join(dependencies.mountRoot, id);
  try {
    await writeCredentials(credentials, request);
    await makeDirectory(mountPoint, 0o755);
    await requireDirectory(mountPoint, dependencies.rootUid);
    try {
      await dependencies.execFile("mount.cifs", mountArguments(request, mountPoint, credentials, account), EXEC_OPTIONS);
    } catch (error) {
      // Only an empty directory goes; one that holds an earlier mount stays.
      await rmdir(mountPoint).catch(() => undefined);
      throw mountFailure(error);
    }
  } finally {
    await removeFile(credentials);
  }
}

/** Whether `/proc/self/mountinfo` lists the path as a mount point (its fifth field). */
export function isMountPoint(mountInfo: string, path: string): boolean {
  return mountInfo.split("\n").some((line) => line.split(" ")[4] === path);
}

async function unmount(id: string, dependencies: HelperDependencies): Promise<void> {
  // Leftovers of a run that never finished.
  await inRequestDirectory(dependencies.requestDir, (pinned) => removeFile(join(pinned, `${id}.json`))).catch(() => undefined);
  await removeFile(join(dependencies.credentialsDir, `${id}.cred`));

  await requireDirectory(dependencies.mountRoot, dependencies.rootUid);
  const mountPoint = join(dependencies.mountRoot, id);
  if (isMountPoint(await dependencies.mountInfo(), mountPoint)) {
    try {
      await dependencies.execFile("umount", [mountPoint], EXEC_OPTIONS);
    } catch {
      throw new Failure(EXIT_CODES.unmountFailed, "umount failed");
    }
  }
  try {
    await rmdir(mountPoint);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function exitCodeOf(error: unknown): ExitCode {
  if (error instanceof Failure) return error.exitCode;
  if (error instanceof RequestFileError) return error.problem === "missing" ? EXIT_CODES.requestMissing : EXIT_CODES.requestRefused;
  return EXIT_CODES.internal;
}

/** Runs `mount <id>` or `unmount <id>` and answers the exit code; failures write one line naming the reason. */
export async function runHelper(argv: readonly string[], dependencies: HelperDependencies): Promise<ExitCode> {
  const [verb, rawId, ...rest] = argv;
  if ((verb !== "mount" && verb !== "unmount") || rawId === undefined || !UUID.test(rawId) || rest.length > 0) {
    dependencies.writeError("usage: mount-helper.mjs mount|unmount <uuid>");
    return EXIT_CODES.usage;
  }
  const id = rawId.toLowerCase();
  try {
    await (verb === "mount" ? mount(id, dependencies) : unmount(id, dependencies));
    return EXIT_CODES.ok;
  } catch (error) {
    // No message here holds a field's value: the request and the password never reach the journal.
    const message = error instanceof Error ? error.message : "unknown error";
    dependencies.writeError(`${verb} ${id}: ${message}`);
    return exitCodeOf(error);
  }
}

if (import.meta.main) {
  process.exitCode = await runHelper(process.argv.slice(2), {
    requestDir: "/run/not-unreachable/mount-requests",
    credentialsDir: "/run/not-unreachable-mount",
    mountRoot: "/srv/not-unreachable/mounts",
    rootUid: 0,
    serviceUser: async () => lookUpAccount(await readFile("/etc/passwd", "utf8"), "not-unreachable"),
    mountInfo: () => readFile("/proc/self/mountinfo", "utf8"),
    execFile: promisify(execFile),
    writeError: (line) => process.stderr.write(`${line}\n`),
  });
}
