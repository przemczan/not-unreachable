/**
 * Reading a request file the service user wrote, and finding that user, for the root helpers (the
 * mount helper, the folder helper and the update helper). The file and the directory it lies in are the service user's, so both are hostile:
 * the directory is pinned with O_NOFOLLOW, the file opened with O_NOFOLLOW and checked through the
 * descriptor it is read from.
 *
 * It imports only `node:` built-ins: the helpers run as root and ship as built files alone.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/** The size a request file must stay under, unless a helper asks for less. */
export const MAX_REQUEST_BYTES = 8192;

/** Why a request file can't be read: there is none, or it isn't one the helper may trust. */
export type RequestFileProblem = "missing" | "refused";

export class RequestFileError extends Error {
  override readonly name = "RequestFileError";
  readonly problem: RequestFileProblem;

  constructor(problem: RequestFileProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

export function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * Runs `work` with the request directory pinned: the service user owns it and could swap it for a
 * symlink, so it is opened once with O_NOFOLLOW and the request is reached through
 * `/proc/self/fd/<n>/`, which resolves to the directory opened, not to whatever the name points at
 * by then (Node has no openat). Answers undefined when there is no such directory to open.
 */
export async function inRequestDirectory<T>(path: string, work: (pinned: string) => Promise<T>): Promise<T | undefined> {
  let directory: FileHandle;
  try {
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new RequestFileError("refused", "the request directory is not a directory");
  }
  try {
    return await work(`/proc/self/fd/${directory.fd}`);
  } finally {
    await directory.close();
  }
}

/** Reads the request through one descriptor, so what was checked is what is read; it must be under `maxBytes`. */
export async function readRequest(path: string, serviceUid: number, maxBytes: number = MAX_REQUEST_BYTES): Promise<Buffer> {
  let handle;
  try {
    // O_NONBLOCK: opening a FIFO would otherwise wait for a writer.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new RequestFileError("missing", "no request file");
    const reason = errorCode(error) === "ELOOP" ? "is a symlink" : "can't be opened";
    throw new RequestFileError("refused", `the request file ${reason}`);
  }
  try {
    const stats = await handle.stat();
    const limit = `${maxBytes / 1024} KiB`;
    if (!stats.isFile() || stats.uid !== serviceUid || (stats.mode & 0o7777) !== 0o600 || stats.size >= maxBytes) {
      throw new RequestFileError("refused", `the request file is not a regular 0600 file of the service user under ${limit}`);
    }
    // Read at most the limit, whatever the size has grown to since fstat.
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length >= maxBytes) throw new RequestFileError("refused", `the request file is ${limit} or more`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export interface Account {
  readonly uid: number;
  readonly gid: number;
}

/** The uid and gid of a user in `/etc/passwd` (Node has no getpwnam). */
export function lookUpAccount(passwd: string, name: string): Account {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name && uid !== undefined && gid !== undefined && /^\d+$/u.test(uid) && /^\d+$/u.test(gid)) {
      return { uid: Number(uid), gid: Number(gid) };
    }
  }
  throw new Error(`no user ${name} in /etc/passwd`);
}
