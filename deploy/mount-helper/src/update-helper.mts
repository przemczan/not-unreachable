/**
 * The update helper (deployment.md, "Updating from Settings"): installs a newer signed release that
 * the server downloaded, and rolls it back when the new release doesn't come up healthy. Two units
 * run it, so hostile input never meets broad rights:
 *
 * - `verify` (`not-unreachable-update.service`, which polkit lets the service user start only while
 *   `UPDATE_FROM_UI=true`) handles everything the server could have shaped: the request, the spool
 *   files, the archive. It has almost no rights: it copies the spool into its own folder, verifies
 *   the signature with the keys `current` pins, unpacks the archive there, and starts the apply unit.
 * - `apply` (`not-unreachable-update-apply.service`, started by root only) reads nothing but root's
 *   own files, already verified: it runs the staged release's installer, restarts the service,
 *   checks it is healthy, and rolls back otherwise. `update-recover` starts it too, to finish an
 *   update a power cut or a killed unit left half-way.
 *
 * The verify unit's result is its exit code; both write the status file the server reads.
 *
 * It imports only `node:` built-ins and its sibling modules, so the built files are those and
 * nothing else.
 */
import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, statfs, type FileHandle } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { SERVICE_UNIT } from "./folder-access.mts";
import { parseEnvironmentFile } from "./folder-helper.mts";
import { ArchiveError, checkReleaseArchive, unpackReleaseArchive } from "./release-archive.mts";
import {
  CHECKSUMS_FILE,
  checkChecksum,
  compareVersions,
  isReleaseVersion,
  MAX_CHECKSUMS_FILE_BYTES,
  MAX_SIGNATURE_FILE_BYTES,
  MAX_TARBALL_BYTES,
  parseChecksums,
  readTrustedKeys,
  releaseArchitecture,
  releaseName,
  ReleaseVerifyError,
  SIGNATURE_FILE,
  tarballName,
  TRUSTED_KEYS_FOLDER,
  verifyChecksumsSignature,
  type ReleaseArchitecture,
} from "./release-verify.mts";
import { errorCode, inRequestDirectory, lookUpAccount, readRequest, RequestFileError, type Account } from "./request-file.mts";

/** The verify unit's exit codes; the server reads them from `ExecMainStatus` (deployment.md, "The update contracts"). */
export const UPDATE_EXIT_CODES = {
  /** Verified, staged, and the apply unit started; for `apply`, the update finished, whatever its result, short of `rollback-failed`. */
  ok: 0,
  /** Anything unexpected; for `apply`, also `rollback-failed`. */
  internal: 1,
  /** Not `verify` or `apply`. */
  usage: 2,
  /** No request file. */
  requestMissing: 3,
  /** The request is a symlink, not a regular file, not the service user's, not 0600, 4 KiB or more; or its folder isn't one. */
  requestRefused: 4,
  /** The request isn't UTF-8 JSON, has missing or unknown keys, or a bad request id or version. */
  requestInvalid: 5,
  /** `UPDATE_FROM_UI` is not `true`. */
  switchOff: 6,
  /** config.env isn't root's regular file, is writable by group or others, can't be read, or holds a bad DATA_DIR. */
  configRefused: 7,
  /** The apply unit is running. */
  busy: 8,
  /** An earlier update stopped half-way; `update-recover` first. */
  interrupted: 9,
  /** A spool file is missing. */
  spoolMissing: 20,
  /** A spool file is a symlink, not a regular file, not the service user's, or over its cap. */
  spoolRefused: 21,
  /** No `SHA256SUMS.sig`, or no line with a trusted key id. */
  unsigned: 22,
  /** A trusted line doesn't verify, or the signature file is malformed. */
  signatureInvalid: 23,
  /** No line for the tarball, a malformed `SHA256SUMS`, or a different SHA-256. */
  checksumMismatch: 24,
  /** `VERSION` or `ARCH` in the tarball isn't the signed name's. */
  versionMismatch: 25,
  /** The same as or older than `current`. */
  notNewer: 26,
  /** An entry breaks the archive rules. */
  archiveUnsafe: 27,
  /** Not a gzip tar, corrupt or truncated. */
  archiveInvalid: 28,
  /** `current` has no kept installer. */
  needsInstaller: 29,
  /** The apply unit couldn't be started. */
  systemdFailed: 30,
  /** Not enough free disk space. */
  noSpace: 31,
} as const;

export type UpdateExitCode = (typeof UPDATE_EXIT_CODES)[keyof typeof UPDATE_EXIT_CODES];

/** The reasons the helper writes; `updateReasons` of `packages/contracts` lists them with the server's own. */
export type UpdateHelperReason =
  | "internal"
  | "request-invalid"
  | "switch-off"
  | "busy"
  | "interrupted"
  | "download-incomplete"
  | "unsigned"
  | "signature-invalid"
  | "checksum-mismatch"
  | "version-mismatch"
  | "not-newer"
  | "archive-unsafe"
  | "archive-invalid"
  | "needs-installer"
  | "systemd-failed"
  | "no-space"
  | "installer-failed"
  | "start-failed"
  | "unhealthy";

/** The reason of each exit code but 0, as the design's table gives it. */
export const UPDATE_EXIT_REASONS: Readonly<Record<Exclude<UpdateExitCode, 0>, UpdateHelperReason>> = {
  1: "internal",
  2: "internal",
  3: "request-invalid",
  4: "request-invalid",
  5: "request-invalid",
  6: "switch-off",
  7: "internal",
  8: "busy",
  9: "interrupted",
  20: "download-incomplete",
  21: "download-incomplete",
  22: "unsigned",
  23: "signature-invalid",
  24: "checksum-mismatch",
  25: "version-mismatch",
  26: "not-newer",
  27: "archive-unsafe",
  28: "archive-invalid",
  29: "needs-installer",
  30: "systemd-failed",
  31: "no-space",
};

export const UPDATE_REQUEST_FILE = "update.json";
export const MAX_UPDATE_REQUEST_BYTES = 4096;
export const VERIFY_UNIT = "not-unreachable-update.service";
export const APPLY_UNIT = "not-unreachable-update-apply.service";
/** The fixed paths production uses. */
export const UPDATE_PATHS = {
  requestDir: "/run/not-unreachable/update-requests",
  configFile: "/etc/not-unreachable/config.env",
  stateDir: "/var/lib/not-unreachable-update",
  releaseDir: "/opt/not-unreachable",
} as const;
export const STATUS_FILE = "status.json";
export const WORK_FOLDER = "work";
export const LOCK_FILE = "lock";
export const STAGED_FILE = "staged.json";
/** What the apply unit notes before it changes anything, so a rollback after a crash knows it too. */
export const APPLY_FILE = "apply.json";
/** The spool, below DATA_DIR. */
export const SPOOL_FOLDER = "updates";
const DEFAULT_DATA_DIR = "/var/lib/not-unreachable";
const MAX_CONFIG_BYTES = 65_536;
const PRE_MIGRATION_BACKUP = /^pre-migration-\d{8}T\d{9}Z\.sqlite$/u;
const DATABASE_FILE = "not-unreachable.sqlite";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_ID = /^[0-9a-f]{16}$/u;
const COPY_CHUNK_BYTES = 1024 * 1024;

const SYSTEMCTL_TIMEOUT = 60_000;
export const INSTALLER_TIMEOUT = 10 * 60_000;
export const RESTART_TIMEOUT = 5 * 60_000;
/** Healthy: the service stays up this long, checked every HEALTH_POLL. */
export const HEALTH_WINDOW = 30_000;
const HEALTH_POLL = 5000;
const HEALTH_REQUEST_TIMEOUT = 5000;
// What a unit reports while it runs or is about to; anything else is at rest.
const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

// --- Dependencies -------------------------------------------------------------------------------

export interface RunOptions {
  readonly timeout: number;
  /** Let the program write to the helper's own output (the journal) instead of capturing it. */
  readonly inheritOutput?: boolean;
  readonly cwd?: string;
}

/** `code` is null when the program couldn't start, was killed, or ran past its time. */
export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
}

/** Runs a program with an argument array (never a shell); it never rejects. */
export type RunProgram = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** The part of `fetch` the health check uses. */
export type HealthFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly redirect: "manual"; readonly signal: AbortSignal },
) => Promise<{ readonly status: number }>;

/** What the helper works with; production passes the fixed paths, tests point it at temp dirs. */
export interface UpdateHelperDependencies {
  readonly requestDir: string;
  readonly configFile: string;
  readonly stateDir: string;
  readonly releaseDir: string;
  /** Who must own config.env: root, except in unit tests. */
  readonly rootUid: number;
  /** `process.arch`. */
  readonly arch: string;
  readonly serviceUser: () => Promise<Account>;
  readonly run: RunProgram;
  /** The bytes free for root in the file system holding the path. */
  readonly freeBytes: (path: string) => Promise<number>;
  readonly fetch: HealthFetch;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeError: (line: string) => void;
}

class Failure extends Error {
  readonly exitCode: UpdateExitCode;

  constructor(exitCode: UpdateExitCode, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const workDir = (dependencies: UpdateHelperDependencies): string => join(dependencies.stateDir, WORK_FOLDER);

// --- The status file ----------------------------------------------------------------------------

export const updateStatusPhases = ["verifying", "verified", "installing", "restarting", "rolling-back", "finished"] as const;
export type UpdateStatusPhase = (typeof updateStatusPhases)[number];
export type UpdateHelperResult = "succeeded" | "refused" | "rolled-back" | "rollback-failed" | "interrupted";

/** `status.json`, as `updateStatusFileSchema` of `packages/contracts` reads it. */
export interface UpdateStatus {
  readonly schema: 1;
  readonly requestId: string;
  readonly from: string;
  readonly to: string;
  readonly phase: UpdateStatusPhase;
  readonly result: UpdateHelperResult | null;
  readonly reason: UpdateHelperReason | null;
  readonly signingKey: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

/** The phases in which the host may already be changed: only a rollback brings it back. */
const HOST_CHANGING_PHASES: ReadonlySet<string> = new Set(["installing", "restarting", "rolling-back"]);

function isStatusPhase(value: unknown): value is UpdateStatusPhase {
  return updateStatusPhases.some((phase) => phase === value);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The status as the helper wrote it, or undefined when there is none or it isn't one it could have
 * written. Only the fields carried into the next write are checked: the phase, the ids, the
 * versions, the key and the start.
 */
async function readStatus(dependencies: UpdateHelperDependencies): Promise<UpdateStatus | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(dependencies.stateDir, STATUS_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { requestId, from, to, phase, signingKey, startedAt } = value;
  if (
    typeof requestId !== "string" ||
    !UUID.test(requestId) ||
    typeof from !== "string" ||
    !isReleaseVersion(from) ||
    typeof to !== "string" ||
    !isReleaseVersion(to) ||
    !isStatusPhase(phase) ||
    !(signingKey === null || (typeof signingKey === "string" && KEY_ID.test(signingKey))) ||
    !isIsoTime(startedAt)
  ) {
    return undefined;
  }
  // Rebuilt from the checked fields, so a write based on it holds nothing else; every write sets
  // the result, reason and times anew.
  return {
    schema: 1,
    requestId,
    from,
    to,
    phase,
    result: null,
    reason: null,
    signingKey,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
  };
}

/** Replaces the status file atomically: temporary file, fsync, rename, then the folder fsynced. */
async function writeStatus(dependencies: UpdateHelperDependencies, status: UpdateStatus): Promise<void> {
  const target = join(dependencies.stateDir, STATUS_FILE);
  const temporary = join(dependencies.stateDir, `.${STATUS_FILE}.tmp`);
  await rm(temporary, { force: true });
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(status, null, 2)}\n`);
    // The server reads it as the service user.
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncFolder(dependencies.stateDir);
}

async function syncFolder(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function withPhase(
  dependencies: UpdateHelperDependencies,
  status: UpdateStatus,
  phase: Exclude<UpdateStatusPhase, "finished">,
): UpdateStatus {
  return { ...status, phase, result: null, reason: null, updatedAt: dependencies.now().toISOString(), finishedAt: null };
}

function finished(
  dependencies: UpdateHelperDependencies,
  status: UpdateStatus,
  result: UpdateHelperResult,
  reason: UpdateHelperReason | null,
): UpdateStatus {
  const now = dependencies.now().toISOString();
  return {
    ...status,
    phase: "finished",
    result,
    reason: result === "succeeded" ? null : (reason ?? "internal"),
    updatedAt: now,
    finishedAt: now,
  };
}

// --- config.env ---------------------------------------------------------------------------------

const refused = (message: string): Failure => new Failure(UPDATE_EXIT_CODES.configRefused, message);

/** config.env's values, read through one descriptor: root's regular file, not writable by group or others. */
async function readConfig(dependencies: UpdateHelperDependencies): Promise<Map<string, string>> {
  const path = dependencies.configFile;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw refused(`${path} can't be opened`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.uid !== dependencies.rootUid || (stats.mode & 0o022) !== 0 || stats.size >= MAX_CONFIG_BYTES) {
      throw refused(`${path} is not root's regular file under 64 KiB, unwritable by group and others`);
    }
    const content = await readCapped(handle, MAX_CONFIG_BYTES);
    if (content === undefined) throw refused(`${path} is 64 KiB or more`);
    return parseEnvironmentFile(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw refused(`${path} can't be read`);
  } finally {
    await handle.close();
  }
}

/** Up to `limit` bytes less one from the start of the file; undefined when it holds more. */
async function readCapped(handle: FileHandle, limit: number): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(limit);
  let length = 0;
  while (length < limit) {
    const { bytesRead } = await handle.read(buffer, length, limit - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return length >= limit ? undefined : buffer.subarray(0, length);
}

function dataDirOf(values: ReadonlyMap<string, string>): string {
  const written = values.get("DATA_DIR") ?? "";
  const dataDir = written === "" ? DEFAULT_DATA_DIR : written;
  if (!isAbsolute(dataDir))
    throw new Failure(UPDATE_EXIT_CODES.configRefused, `DATA_DIR ${JSON.stringify(dataDir)} is not an absolute path`);
  return dataDir;
}

const updatesFromUi = (values: ReadonlyMap<string, string>): boolean => values.get("UPDATE_FROM_UI") === "true";

// --- The request --------------------------------------------------------------------------------

export interface UpdateRequest {
  readonly requestId: string;
  readonly version: string;
}

const invalid = (message: string): Failure => new Failure(UPDATE_EXIT_CODES.requestInvalid, message);

/** `{"requestId": "<UUID>", "version": "<version>"}` and nothing else. */
export function parseUpdateRequest(content: Uint8Array): UpdateRequest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw invalid("the request is not UTF-8 JSON");
  }
  if (!isRecord(value)) throw invalid("the request is not a JSON object");
  const keys = Object.keys(value).toSorted();
  if (keys.length !== 2 || keys[0] !== "requestId" || keys[1] !== "version") throw invalid("the request has missing or unknown fields");
  const { requestId, version } = value;
  // The id names a folder of the helper's, so only the lower-case form the server writes is taken.
  if (typeof requestId !== "string" || !UUID.test(requestId)) throw invalid("the request id is not a UUID");
  if (typeof version !== "string" || !isReleaseVersion(version)) throw invalid("the request's version is not a release version");
  return { requestId, version };
}

async function readUpdateRequest(dependencies: UpdateHelperDependencies, account: Account): Promise<UpdateRequest> {
  // The server deletes the request once the unit ends, as for the folder helper.
  const content = await inRequestDirectory(dependencies.requestDir, (pinned) =>
    readRequest(join(pinned, UPDATE_REQUEST_FILE), account.uid, MAX_UPDATE_REQUEST_BYTES),
  );
  if (content === undefined) throw new Failure(UPDATE_EXIT_CODES.requestMissing, "no request directory");
  return parseUpdateRequest(content);
}

// --- Releases -----------------------------------------------------------------------------------

function ownArchitecture(dependencies: UpdateHelperDependencies): ReleaseArchitecture {
  const arch = releaseArchitecture(dependencies.arch);
  if (arch === undefined) throw new Failure(UPDATE_EXIT_CODES.internal, `there are no releases for ${dependencies.arch}`);
  return arch;
}

/** The version `current` points to, from its `VERSION`. */
async function currentVersion(dependencies: UpdateHelperDependencies): Promise<string> {
  const version = (await readFile(join(dependencies.releaseDir, "current", "VERSION"), "utf8")).replace(/\n$/u, "");
  if (!isReleaseVersion(version)) throw new Failure(UPDATE_EXIT_CODES.internal, "current's VERSION is not a release version");
  return version;
}

async function isFolder(path: string): Promise<boolean> {
  return lstat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

// --- The lock and the work folder ---------------------------------------------------------------

async function prepareWork(dependencies: UpdateHelperDependencies): Promise<void> {
  const work = workDir(dependencies);
  try {
    await mkdir(work, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  // The state folder is root's 0755, so only the helper itself makes anything in it.
  if (!(await lstat(work)).isDirectory()) throw new Failure(UPDATE_EXIT_CODES.internal, `${work} is not a folder`);
}

async function createLock(dependencies: UpdateHelperDependencies, requestId: string | null): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(
      join(workDir(dependencies), LOCK_FILE),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ requestId, createdAt: dependencies.now().toISOString() })}\n`);
  } finally {
    await handle.close();
  }
  return true;
}

/** Notes the request id in the lock once it is known. */
async function noteLockRequest(dependencies: UpdateHelperDependencies, requestId: string): Promise<void> {
  const handle = await open(join(workDir(dependencies), LOCK_FILE), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    await handle.writeFile(`${JSON.stringify({ requestId, createdAt: dependencies.now().toISOString() })}\n`);
  } finally {
    await handle.close();
  }
}

/** Removes everything in `work/`, the lock last, so a crash half-way still leaves the lock. */
async function clearWork(dependencies: UpdateHelperDependencies): Promise<void> {
  const work = workDir(dependencies);
  let names: string[];
  try {
    names = await readdir(work);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter((entry) => entry !== LOCK_FILE)) await rm(join(work, name), { recursive: true, force: true });
  await rm(join(work, LOCK_FILE), { force: true });
}

async function unitRunning(dependencies: UpdateHelperDependencies, unit: string): Promise<boolean> {
  const { code, stdout } = await dependencies.run("systemctl", ["is-active", unit], { timeout: SYSTEMCTL_TIMEOUT });
  // is-active exits non-zero for every state but active, so only a missing answer is a failure.
  if (code === null || stdout.trim() === "") throw new Failure(UPDATE_EXIT_CODES.internal, `systemctl is-active ${unit} failed`);
  return RUNNING_STATES.has(stdout.trim());
}

/**
 * Takes the lock. A lock already there is left by a run that ended badly. While the apply unit runs
 * it is its lock (`busy`). Otherwise the status tells whether the host may have changed: in
 * `installing`, `restarting` or `rolling-back`, only `update-recover` may go on (`interrupted`). In
 * any other phase nothing on the host changed since the last finished update, so the lock and the
 * work are cleared: `verifying` and `verified` as the design says, and also no status, another
 * request's status, or `finished`, which a run killed between its last status write and removing
 * the lock leaves behind. A status in a host-changing phase refuses even without a lock.
 */
async function takeLock(dependencies: UpdateHelperDependencies): Promise<void> {
  await prepareWork(dependencies);
  if (await createLock(dependencies, null)) {
    const status = await readStatus(dependencies);
    if (status !== undefined && HOST_CHANGING_PHASES.has(status.phase)) {
      await rm(join(workDir(dependencies), LOCK_FILE), { force: true });
      throw new Failure(UPDATE_EXIT_CODES.interrupted, `the update to ${status.to} stopped while ${status.phase}; run update-recover`);
    }
    return;
  }
  if (await unitRunning(dependencies, APPLY_UNIT)) throw new Failure(UPDATE_EXIT_CODES.busy, "an update is being applied");
  const status = await readStatus(dependencies);
  if (status !== undefined && HOST_CHANGING_PHASES.has(status.phase)) {
    throw new Failure(UPDATE_EXIT_CODES.interrupted, `the update to ${status.to} stopped while ${status.phase}; run update-recover`);
  }
  await clearWork(dependencies);
  if (!(await createLock(dependencies, null))) throw new Failure(UPDATE_EXIT_CODES.internal, "the lock came back while it was cleared");
}

// --- The spool ----------------------------------------------------------------------------------

interface SpoolFile {
  readonly name: string;
  readonly cap: number;
  /** A missing signature is `unsigned`, found at the signature step; any other missing file is `download-incomplete`. */
  readonly optional: boolean;
}

interface Copies {
  readonly tarball: string;
  readonly tarballDigest: string;
  readonly checksums: Buffer;
  readonly signature: Buffer | undefined;
}

const spoolMissing = (message: string): Failure => new Failure(UPDATE_EXIT_CODES.spoolMissing, message);
const spoolRefused = (message: string): Failure => new Failure(UPDATE_EXIT_CODES.spoolRefused, message);

/** A spool file opened without following a symlink, and checked on its descriptor; undefined when missing. */
async function openSpoolFile(path: string, file: SpoolFile, serviceUid: number): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO would otherwise wait for a writer.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      if (file.optional) return undefined;
      throw spoolMissing(`the spool has no ${file.name}`);
    }
    throw spoolRefused(`the spool's ${file.name} ${errorCode(error) === "ELOOP" ? "is a symlink" : "can't be opened"}`);
  }
  const stats = await handle.stat();
  if (!stats.isFile() || stats.uid !== serviceUid || stats.size > file.cap) {
    await handle.close();
    throw spoolRefused(`the spool's ${file.name} is not a regular file of the service user within its cap`);
  }
  return handle;
}

/**
 * Copies the file into `destination` while counting bytes, so a file that grows past its cap after
 * the check is refused; answers what it copied when `keep`, and feeds `hash`.
 */
async function copyCapped(
  source: FileHandle,
  destination: string,
  file: SpoolFile,
  hash: Hash | undefined,
  keep: boolean,
): Promise<Buffer> {
  const target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const kept: Buffer[] = [];
  try {
    const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
    let copied = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, copied);
      if (bytesRead === 0) break;
      copied += bytesRead;
      if (copied > file.cap) throw spoolRefused(`the spool's ${file.name} grew past its cap`);
      const piece = buffer.subarray(0, bytesRead);
      hash?.update(piece);
      if (keep) kept.push(Buffer.from(piece));
      await target.write(piece);
    }
    await target.sync();
  } finally {
    await target.close();
  }
  return Buffer.concat(kept);
}

/** Opens the spool through its folder, opened once without following a symlink. */
async function inSpool<T>(dataDir: string, work: (spool: string) => Promise<T>): Promise<T> {
  // DATA_DIR comes from root's config.env and lies in a folder of root's, so its own name is
  // trusted; the spool folder within it is the service user's, and is pinned.
  let data: FileHandle;
  try {
    data = await open(dataDir, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw spoolMissing("there is no DATA_DIR");
    throw error;
  }
  try {
    const result = await inRequestDirectory(`/proc/self/fd/${data.fd}/${SPOOL_FOLDER}`, work).catch((error: unknown) => {
      if (error instanceof RequestFileError) throw spoolRefused("the spool is not a folder");
      throw error;
    });
    if (result === undefined) throw spoolMissing("there is no spool folder");
    return result;
  } finally {
    await data.close();
  }
}

/** Private copies of the three spool files in `folder`, once there is room for the update. */
async function copySpool(
  dependencies: UpdateHelperDependencies,
  dataDir: string,
  version: string,
  arch: ReleaseArchitecture,
  folder: string,
): Promise<Copies> {
  const account = await dependencies.serviceUser();
  const tarball: SpoolFile = { name: tarballName(version, arch), cap: MAX_TARBALL_BYTES, optional: false };
  const checksums: SpoolFile = { name: CHECKSUMS_FILE, cap: MAX_CHECKSUMS_FILE_BYTES, optional: false };
  const signature: SpoolFile = { name: SIGNATURE_FILE, cap: MAX_SIGNATURE_FILE_BYTES, optional: true };
  return inSpool(dataDir, async (spool) => {
    const handles: FileHandle[] = [];
    const openOne = async (file: SpoolFile): Promise<FileHandle | undefined> => {
      const handle = await openSpoolFile(join(spool, file.name), file, account.uid);
      if (handle !== undefined) handles.push(handle);
      return handle;
    };
    try {
      const tarballHandle = await openOne(tarball);
      const checksumsHandle = await openOne(checksums);
      const signatureHandle = await openOne(signature);
      if (tarballHandle === undefined || checksumsHandle === undefined) throw spoolMissing("a spool file is missing");
      await checkFreeSpace(dependencies, (await tarballHandle.stat()).size);
      const hash = createHash("sha256");
      const tarballCopy = join(folder, tarball.name);
      await copyCapped(tarballHandle, tarballCopy, tarball, hash, false);
      return {
        tarball: tarballCopy,
        tarballDigest: hash.digest("hex"),
        checksums: await copyCapped(checksumsHandle, join(folder, checksums.name), checksums, undefined, true),
        signature:
          signatureHandle === undefined
            ? undefined
            : await copyCapped(signatureHandle, join(folder, signature.name), signature, undefined, true),
      };
    } finally {
      for (const handle of handles) await handle.close();
    }
  });
}

/** Three times the tarball, in `/opt` (the release) and in the state folder (the copy and the staged release). */
async function checkFreeSpace(dependencies: UpdateHelperDependencies, tarballBytes: number): Promise<void> {
  const needed = 3 * tarballBytes;
  for (const path of [dependencies.releaseDir, dependencies.stateDir]) {
    if ((await dependencies.freeBytes(path)) < needed)
      throw new Failure(UPDATE_EXIT_CODES.noSpace, `${path} has less than ${needed} bytes free`);
  }
}

// --- verify -------------------------------------------------------------------------------------

/** `work/staged.json`: what the verify unit hands to the apply unit. */
interface Staged {
  readonly requestId: string;
  readonly from: string;
  readonly to: string;
  /** The staged release's top folder, holding its `install.sh`. */
  readonly staged: string;
}

function stagedFolder(dependencies: UpdateHelperDependencies, requestId: string, version: string): string {
  return join(workDir(dependencies), requestId, "staged", releaseName(version, ownArchitecture(dependencies)));
}

const VERIFY_EXIT_CODES: Readonly<Record<ReleaseVerifyError["problem"], UpdateExitCode>> = {
  unsigned: UPDATE_EXIT_CODES.unsigned,
  "signature-invalid": UPDATE_EXIT_CODES.signatureInvalid,
  "checksum-mismatch": UPDATE_EXIT_CODES.checksumMismatch,
};

const ARCHIVE_EXIT_CODES: Readonly<Record<ArchiveError["problem"], UpdateExitCode>> = {
  "archive-unsafe": UPDATE_EXIT_CODES.archiveUnsafe,
  "archive-invalid": UPDATE_EXIT_CODES.archiveInvalid,
};

/** The key id that verified `SHA256SUMS`, with the keys `current` pins. */
async function verifySignature(dependencies: UpdateHelperDependencies, copies: Copies): Promise<string> {
  let keys;
  try {
    keys = await readTrustedKeys(join(dependencies.releaseDir, "current", TRUSTED_KEYS_FOLDER));
  } catch (error) {
    throw new Failure(UPDATE_EXIT_CODES.internal, `current's pinned keys can't be read: ${oneLine(error)}`);
  }
  if (copies.signature === undefined) throw new Failure(UPDATE_EXIT_CODES.unsigned, `the spool has no ${SIGNATURE_FILE}`);
  return verifyChecksumsSignature(copies.checksums, copies.signature, keys);
}

/** Checks the signed copies and unpacks the release into `folder/staged/`. */
async function checkAndStage(
  dependencies: UpdateHelperDependencies,
  status: UpdateStatus,
  copies: Copies,
  arch: ReleaseArchitecture,
  folder: string,
): Promise<void> {
  const { to: version, from } = status;
  checkChecksum(parseChecksums(copies.checksums), tarballName(version, arch), copies.tarballDigest);
  const top = releaseName(version, arch);
  const identity = await checkReleaseArchive(copies.tarball, top);
  if (identity.version !== version || identity.arch !== arch) {
    throw new Failure(UPDATE_EXIT_CODES.versionMismatch, `the tarball's VERSION or ARCH is not ${version} ${arch}`);
  }
  if (compareVersions(version, from) <= 0) throw new Failure(UPDATE_EXIT_CODES.notNewer, `${version} is not newer than ${from}`);
  if (!(await isFolder(join(dependencies.releaseDir, "current", "installer")))) {
    throw new Failure(UPDATE_EXIT_CODES.needsInstaller, `${from} has no kept installer; install ${version} over SSH`);
  }
  const staged = join(folder, "staged");
  await mkdir(staged, { mode: 0o755 });
  await unpackReleaseArchive(copies.tarball, top, staged);
}

/**
 * The verify unit. A refusal before the request is read and `current`'s version known (busy,
 * interrupted, the switch, config.env, the request, an unknown architecture) writes no status file:
 * the schema needs the request id and both versions, the server learns the reason from the exit
 * code, and the file keeps the last update's status, which `busy` and `interrupted` are about.
 * From then on, every refusal writes `finished`, `refused` and its reason.
 */
async function verify(dependencies: UpdateHelperDependencies): Promise<void> {
  await takeLock(dependencies);
  let status: UpdateStatus | undefined;
  try {
    const values = await readConfig(dependencies);
    if (!updatesFromUi(values)) throw new Failure(UPDATE_EXIT_CODES.switchOff, "UPDATE_FROM_UI is not true in config.env");
    const dataDir = dataDirOf(values);
    const account = await dependencies.serviceUser();
    const request = await readUpdateRequest(dependencies, account);
    const arch = ownArchitecture(dependencies);
    const from = await currentVersion(dependencies);
    const now = dependencies.now().toISOString();
    status = {
      schema: 1,
      requestId: request.requestId,
      from,
      to: request.version,
      phase: "verifying",
      result: null,
      reason: null,
      signingKey: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await writeStatus(dependencies, status);
    await noteLockRequest(dependencies, request.requestId);

    const folder = join(workDir(dependencies), request.requestId);
    await mkdir(folder, { mode: 0o700 });
    const copies = await copySpool(dependencies, dataDir, request.version, arch, folder);
    status = { ...status, signingKey: await verifySignature(dependencies, copies) };
    await checkAndStage(dependencies, status, copies, arch, folder);

    const staged: Staged = {
      requestId: request.requestId,
      from,
      to: request.version,
      staged: stagedFolder(dependencies, request.requestId, request.version),
    };
    await writeRootFile(join(workDir(dependencies), STAGED_FILE), `${JSON.stringify(staged, null, 2)}\n`);
    status = withPhase(dependencies, status, "verified");
    await writeStatus(dependencies, status);
    const started = await dependencies.run("systemctl", ["start", "--no-block", APPLY_UNIT], { timeout: SYSTEMCTL_TIMEOUT });
    if (started.code !== 0) throw new Failure(UPDATE_EXIT_CODES.systemdFailed, `systemctl start ${APPLY_UNIT} failed`);
  } catch (error) {
    if (status !== undefined) {
      const code = exitCodeOf(error);
      await writeStatus(dependencies, finished(dependencies, status, "refused", code === 0 ? "internal" : UPDATE_EXIT_REASONS[code]));
    }
    await clearWork(dependencies);
    throw error;
  }
}

/** A root-only file in the work folder, fsynced. */
async function writeRootFile(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// --- apply --------------------------------------------------------------------------------------

/** `work/apply.json`: noted before the installer runs, for a rollback, by this run or after a crash. */
interface ApplyNotes {
  readonly requestId: string;
  readonly dataDir: string;
  /** The pre-migration backups there were before the update; the oldest one more is the one its first start made. */
  readonly backupsBefore: readonly string[];
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readStaged(dependencies: UpdateHelperDependencies, status: UpdateStatus): Promise<Staged | undefined> {
  const value = await readJson(join(workDir(dependencies), STAGED_FILE));
  if (!isRecord(value)) return undefined;
  const expected = stagedFolder(dependencies, status.requestId, status.to);
  if (
    value["requestId"] !== status.requestId ||
    value["from"] !== status.from ||
    value["to"] !== status.to ||
    value["staged"] !== expected
  ) {
    return undefined;
  }
  return { requestId: status.requestId, from: status.from, to: status.to, staged: expected };
}

async function readApplyNotes(dependencies: UpdateHelperDependencies, status: UpdateStatus): Promise<ApplyNotes | undefined> {
  const value = await readJson(join(workDir(dependencies), APPLY_FILE));
  if (!isRecord(value)) return undefined;
  const { requestId, dataDir, backupsBefore } = value;
  if (
    requestId !== status.requestId ||
    typeof dataDir !== "string" ||
    !isAbsolute(dataDir) ||
    !Array.isArray(backupsBefore) ||
    !backupsBefore.every((name) => typeof name === "string")
  ) {
    return undefined;
  }
  return { requestId, dataDir, backupsBefore };
}

/** The pre-migration backups in the folder, sorted by name, which is by time, oldest first. */
async function preMigrationBackups(backups: string): Promise<string[]> {
  try {
    return (await readdir(backups)).filter((name) => PRE_MIGRATION_BACKUP.test(name)).toSorted();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/**
 * A folder of the service user's in the pinned `parent`, opened once without following a symlink
 * and checked on its descriptor; undefined when there is none.
 */
async function openServiceFolder(parent: string, name: string, serviceUid: number): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(join(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error(`DATA_DIR/${name} is not a folder`, { cause: error });
  }
  const stats = await handle.stat();
  if (!stats.isDirectory() || stats.uid !== serviceUid) {
    await handle.close();
    throw new Error(`DATA_DIR/${name} is not the service user's folder`);
  }
  return handle;
}

/**
 * Puts the pre-migration backup the update's first start made, if any, back as the database: the
 * oldest one not there before, as a release that crash-loops makes one at every start, of a
 * database already migrated. Copied beside it, given to the service user with mode 0600, fsynced
 * and renamed over it, `-wal` and `-shm` removed. Safe to run again: the backup stays where it is.
 */
async function restoreDatabase(dependencies: UpdateHelperDependencies, notes: ApplyNotes): Promise<void> {
  const account = await dependencies.serviceUser();
  // DATA_DIR's own name is trusted, as for the spool; db/ and backups/ in it are the service user's,
  // so each is pinned, checked, and reached only through its descriptor.
  const data = await open(notes.dataDir, constants.O_RDONLY | constants.O_DIRECTORY);
  const handles: FileHandle[] = [data];
  try {
    const backupsFolder = await openServiceFolder(`/proc/self/fd/${data.fd}`, "backups", account.uid);
    if (backupsFolder === undefined) return;
    handles.push(backupsFolder);
    const backups = `/proc/self/fd/${backupsFolder.fd}`;
    const oldest = (await preMigrationBackups(backups)).find((name) => !notes.backupsBefore.includes(name));
    if (oldest === undefined) return;
    const dbFolder = await openServiceFolder(`/proc/self/fd/${data.fd}`, "db", account.uid);
    if (dbFolder === undefined) throw new Error("DATA_DIR has no db folder");
    handles.push(dbFolder);
    const folder = `/proc/self/fd/${dbFolder.fd}`;
    const database = join(folder, DATABASE_FILE);
    const temporary = join(folder, `.${DATABASE_FILE}.restore`);
    const source = await open(join(backups, oldest), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await source.stat()).isFile()) throw new Error(`${oldest} is not a regular file`);
      await rm(temporary, { force: true });
      const target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
        let position = 0;
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          await target.write(buffer.subarray(0, bytesRead));
        }
        await target.chown(account.uid, account.gid);
        await target.chmod(0o600);
        await target.sync();
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
    await rename(temporary, database);
    await rm(`${database}-wal`, { force: true });
    await rm(`${database}-shm`, { force: true });
    await dbFolder.sync();
    dependencies.writeError(`apply: restored the database from ${oldest}`);
  } finally {
    for (const handle of handles.toReversed()) await handle.close();
  }
}

function parseShow(stdout: string): Map<string, string> {
  return parseEnvironmentFile(stdout);
}

/**
 * Where the health check can ask: the loopback address of LISTEN_HOST, when the service listens
 * there (or on a wildcard) and TRUSTED_PROXIES trusts that address, so `X-Forwarded-Proto: https` is
 * believed. Undefined when it can't ask: the apply unit reaches loopback only.
 */
export function healthCheckUrl(values: ReadonlyMap<string, string> | undefined): string | undefined {
  if (values === undefined) return undefined;
  const host = values.get("LISTEN_HOST") ?? "127.0.0.1";
  const portText = values.get("LISTEN_PORT") ?? "8480";
  const port = /^\d{1,5}$/u.test(portText) ? Number(portText) : 0;
  if (port < 1 || port > 65_535) return undefined;
  const candidates =
    isIP(host) === 4 && host.startsWith("127.")
      ? [host]
      : host === "::1"
        ? ["::1"]
        : host === "0.0.0.0"
          ? ["127.0.0.1"]
          : host === "::"
            ? ["::1", "127.0.0.1"]
            : [];
  const trusted = new BlockList();
  for (const entry of (values.get("TRUSTED_PROXIES") ?? "127.0.0.1,::1").split(",").map((item) => item.trim())) {
    try {
      const [address = "", prefix] = entry.split("/");
      const family = isIP(address) === 6 ? "ipv6" : "ipv4";
      if (prefix === undefined) trusted.addAddress(address, family);
      else trusted.addSubnet(address, Number(prefix), family);
    } catch {
      // The server refuses such a config.env; here it only trusts nothing.
    }
  }
  const address = candidates.find((candidate) => trusted.check(candidate, isIP(candidate) === 6 ? "ipv6" : "ipv4"));
  if (address === undefined) return undefined;
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}/api/v1/health`;
}

/**
 * Healthy: for HEALTH_WINDOW the service stays `active` with the same MainPID and NRestarts, then
 * `/api/v1/health` answers 200 on loopback, when the helper can ask.
 */
async function healthy(dependencies: UpdateHelperDependencies, values: ReadonlyMap<string, string> | undefined): Promise<boolean> {
  const show = async (): Promise<Map<string, string> | undefined> => {
    const { code, stdout } = await dependencies.run("systemctl", ["show", "-p", "ActiveState,MainPID,NRestarts", SERVICE_UNIT], {
      timeout: SYSTEMCTL_TIMEOUT,
    });
    return code === 0 ? parseShow(stdout) : undefined;
  };
  const first = await show();
  const pid = first?.get("MainPID");
  if (first?.get("ActiveState") !== "active" || pid === undefined || pid === "0" || !/^\d+$/u.test(pid)) return false;
  for (let waited = 0; waited < HEALTH_WINDOW; waited += HEALTH_POLL) {
    await dependencies.sleep(HEALTH_POLL);
    const now = await show();
    if (now?.get("ActiveState") !== "active" || now.get("MainPID") !== pid || now.get("NRestarts") !== first.get("NRestarts")) return false;
  }
  const url = healthCheckUrl(values);
  if (url === undefined) {
    dependencies.writeError(
      "apply: the service doesn't listen on a loopback address TRUSTED_PROXIES trusts; the health request is skipped",
    );
    return true;
  }
  try {
    const response = await dependencies.fetch(url, {
      headers: { "X-Forwarded-Proto": "https" },
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function restartService(dependencies: UpdateHelperDependencies): Promise<boolean> {
  return (await dependencies.run("systemctl", ["restart", SERVICE_UNIT], { timeout: RESTART_TIMEOUT })).code === 0;
}

async function runInstaller(dependencies: UpdateHelperDependencies, folder: string): Promise<number | null> {
  const { code } = await dependencies.run("bash", [join(folder, "install.sh"), "--apply-update"], {
    timeout: INSTALLER_TIMEOUT,
    inheritOutput: true,
    cwd: folder,
  });
  return code;
}

async function finish(
  dependencies: UpdateHelperDependencies,
  status: UpdateStatus,
  result: UpdateHelperResult,
  reason: UpdateHelperReason | null,
): Promise<UpdateHelperResult> {
  await writeStatus(dependencies, finished(dependencies, status, result, reason));
  await clearWork(dependencies);
  dependencies.writeError(`apply: the update to ${status.to} ended: ${result}${reason === null ? "" : ` (${reason})`}`);
  return result;
}

async function readConfigOrUndefined(dependencies: UpdateHelperDependencies): Promise<Map<string, string> | undefined> {
  try {
    return await readConfig(dependencies);
  } catch (error) {
    dependencies.writeError(`apply: ${error instanceof Error ? error.message : "config.env can't be read"}`);
    return undefined;
  }
}

/**
 * Brings the old release back (step 4 of the design), from wherever an earlier run stopped: every
 * step is safe to run again. `interrupted` is the reason when recovering.
 */
async function rollBack(
  dependencies: UpdateHelperDependencies,
  current: UpdateStatus,
  reason: "installer-failed" | "start-failed" | "unhealthy" | "interrupted",
): Promise<UpdateHelperResult> {
  const status = withPhase(dependencies, current, "rolling-back");
  await writeStatus(dependencies, status);
  const success: UpdateHelperResult = reason === "interrupted" ? "interrupted" : "rolled-back";
  const failed = async (why: string): Promise<UpdateHelperResult> => {
    dependencies.writeError(`apply: the rollback failed: ${why}`);
    // Leave the service down rather than running the new code, or the old one, on a database it may not match.
    await dependencies.run("systemctl", ["stop", SERVICE_UNIT], { timeout: RESTART_TIMEOUT });
    return finish(dependencies, status, "rollback-failed", reason);
  };

  const notes = await readApplyNotes(dependencies, status);
  if (notes === undefined) return failed(`${APPLY_FILE} is missing, so the backup this start made can't be told`);
  if ((await dependencies.run("systemctl", ["stop", SERVICE_UNIT], { timeout: RESTART_TIMEOUT })).code !== 0) {
    return failed(`systemctl stop ${SERVICE_UNIT} failed`);
  }
  try {
    await restoreDatabase(dependencies, notes);
  } catch (error) {
    return failed(`the database can't be restored: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const installer = join(dependencies.releaseDir, status.from, "installer");
  const code = await runInstaller(dependencies, installer);
  if (code !== 0) return failed(`${join(installer, "install.sh")} --apply-update exited ${code ?? "abnormally"}`);
  if (!(await restartService(dependencies))) return failed(`${status.from} didn't start`);
  if (!(await healthy(dependencies, await readConfigOrUndefined(dependencies)))) return failed(`${status.from} is not healthy`);
  return finish(dependencies, status, success, reason);
}

/** Steps 1 to 4 of the design, from `verified`. */
async function applyVerified(dependencies: UpdateHelperDependencies, verified: UpdateStatus): Promise<UpdateHelperResult> {
  const staged = await readStaged(dependencies, verified);
  if (staged === undefined) {
    dependencies.writeError(`apply: ${STAGED_FILE} doesn't match the status`);
    return finish(dependencies, verified, "refused", "internal");
  }
  let values: Map<string, string>;
  let dataDir: string;
  try {
    values = await readConfig(dependencies);
    dataDir = dataDirOf(values);
  } catch (error) {
    dependencies.writeError(`apply: ${error instanceof Error ? error.message : "config.env can't be read"}`);
    return finish(dependencies, verified, "refused", "internal");
  }
  if (!updatesFromUi(values)) return finish(dependencies, verified, "refused", "switch-off");

  const notes: ApplyNotes = { requestId: verified.requestId, dataDir, backupsBefore: await preMigrationBackups(join(dataDir, "backups")) };
  await rm(join(workDir(dependencies), APPLY_FILE), { force: true });
  await writeRootFile(join(workDir(dependencies), APPLY_FILE), `${JSON.stringify(notes, null, 2)}\n`);
  let status = withPhase(dependencies, verified, "installing");
  await writeStatus(dependencies, status);
  const code = await runInstaller(dependencies, staged.staged);
  if (code === 3) return finish(dependencies, status, "refused", "needs-installer");
  if (code !== 0) return rollBack(dependencies, status, "installer-failed");

  status = withPhase(dependencies, status, "restarting");
  await writeStatus(dependencies, status);
  if (!(await restartService(dependencies))) return rollBack(dependencies, status, "start-failed");
  if (!(await healthy(dependencies, values))) return rollBack(dependencies, status, "unhealthy");
  return finish(dependencies, status, "succeeded", null);
}

/**
 * The apply unit. With no update to apply (no status, or a finished one), it only clears a work
 * folder left behind. A `verifying` status whose verify unit is gone ended before anything changed:
 * it is finished as `refused`, `interrupted`.
 */
async function apply(dependencies: UpdateHelperDependencies): Promise<UpdateHelperResult | undefined> {
  const status = await readStatus(dependencies);
  if (status === undefined || status.phase === "finished") {
    await clearWork(dependencies);
    return undefined;
  }
  if (status.phase === "verifying") {
    if (await unitRunning(dependencies, VERIFY_UNIT)) {
      dependencies.writeError("apply: the verify unit is still running; nothing to do");
      return undefined;
    }
    return finish(dependencies, status, "refused", "interrupted");
  }
  if (status.phase === "verified") return applyVerified(dependencies, status);
  return rollBack(dependencies, status, "interrupted");
}

// --- The verbs ----------------------------------------------------------------------------------

function exitCodeOf(error: unknown): UpdateExitCode {
  if (error instanceof Failure) return error.exitCode;
  if (error instanceof RequestFileError)
    return error.problem === "missing" ? UPDATE_EXIT_CODES.requestMissing : UPDATE_EXIT_CODES.requestRefused;
  if (error instanceof ReleaseVerifyError) return VERIFY_EXIT_CODES[error.problem];
  if (error instanceof ArchiveError) return ARCHIVE_EXIT_CODES[error.problem];
  return UPDATE_EXIT_CODES.internal;
}

function oneLine(error: unknown): string {
  return error instanceof Error ? error.message.replaceAll(/[\r\n]/gu, " ") : "unknown error";
}

/** Runs `verify` or `apply` and answers the exit code; a failure writes one line naming the reason. */
export async function runUpdateHelper(argv: readonly string[], dependencies: UpdateHelperDependencies): Promise<UpdateExitCode> {
  const [verb, ...rest] = argv;
  if (rest.length > 0 || (verb !== "verify" && verb !== "apply")) {
    dependencies.writeError("usage: update-helper.mjs verify|apply");
    return UPDATE_EXIT_CODES.usage;
  }
  try {
    if (verb === "verify") {
      await verify(dependencies);
      return UPDATE_EXIT_CODES.ok;
    }
    const result = await apply(dependencies);
    return result === "rollback-failed" ? UPDATE_EXIT_CODES.internal : UPDATE_EXIT_CODES.ok;
  } catch (error) {
    dependencies.writeError(`${verb}: ${oneLine(error)}`);
    return exitCodeOf(error);
  }
}

// --- Production ---------------------------------------------------------------------------------

const PROGRAM_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } as const;
const MAX_CAPTURED_BYTES = 64 * 1024;
/** How long a program past its time has after SIGTERM before SIGKILL. */
export const KILL_GRACE = 5000;

/**
 * `spawn` with an argument array and the fixed PATH; resolves with the exit code, or null. The
 * program leads its own process group, so at its time SIGTERM, then SIGKILL, reach everything it
 * started (the installer's cp and systemctl too), and the run ends even if one ignores SIGTERM.
 */
export const runProgram: RunProgram = (file, args, options) =>
  new Promise((resolve) => {
    let stdout = "";
    let timedOut = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(file, args, {
      env: PROGRAM_ENV,
      cwd: options.cwd ?? "/",
      stdio: ["ignore", options.inheritOutput === true ? "inherit" : "pipe", "inherit"],
      detached: true,
    });
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is gone already.
      }
    };
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({ code: timedOut ? null : code, stdout });
    };
    termTimer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        // A process that left the group may still hold the output open; the run ends anyway.
        settle(null);
      }, KILL_GRACE);
    }, options.timeout);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (piece: string) => {
      if (stdout.length < MAX_CAPTURED_BYTES) stdout += piece;
    });
    child.on("error", () => settle(null));
    child.on("close", (code, signal) => {
      // What outlived its leader after SIGTERM gets no grace of its own.
      if (timedOut) signalGroup("SIGKILL");
      settle(signal === null ? code : null);
    });
  });

async function freeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

if (import.meta.main) {
  process.exitCode = await runUpdateHelper(process.argv.slice(2), {
    ...UPDATE_PATHS,
    rootUid: 0,
    arch: process.arch,
    serviceUser: async () => lookUpAccount(await readFile("/etc/passwd", "utf8"), "not-unreachable"),
    run: runProgram,
    freeBytes,
    fetch: async (url, init) => fetch(url, init),
    now: () => new Date(),
    sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    writeError: (line) => process.stderr.write(`${line}\n`),
  });
}
