import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { errorCode, PathRefusedError } from "./errors.ts";
import type { PathRefusal } from "./types.ts";

/** What an open is for: a file to read or write, a folder to list or change, or either (stat). */
export type OpenIntent = "read" | "write" | "folder" | "any";

const { O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = constants;

// O_NONBLOCK makes opening a FIFO swapped in after resolving return at once instead of hanging
// (or fail with ENXIO for writing); fstat then refuses it. It has no effect on regular files.
const flags: Record<OpenIntent, number> = {
  read: O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
  write: O_WRONLY | O_NOFOLLOW | O_NONBLOCK,
  folder: O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
  any: O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
};

const refusalByCode: Readonly<Record<string, PathRefusal>> = {
  ELOOP: "symlink",
  ENOENT: "not-found",
  ENOTDIR: "not-a-folder",
  EISDIR: "not-a-file",
  ENXIO: "special-file",
};

/** True if `path` is the root or below it. Both are absolute and symlink-free. */
export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The path of an open descriptor, or of a name inside an open folder. The kernel resolves it to the
 * very inode the descriptor holds, whatever happened to its path since, so using it in place of
 * the path keeps every later call on the entry that was checked (T5 step 6). Linux only.
 */
export function fdPath(handle: FileHandle, name?: string): string {
  return name === undefined ? `/proc/self/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}/${name}`;
}

/** Throws the T5 refusal a system error stands for, or the error itself when it stands for none. */
export function rethrowAsRefusal(error: unknown): never {
  const reason = refusalByCode[errorCode(error) ?? ""];
  throw reason === undefined ? error : new PathRefusedError(reason);
}

/** `lstat`, answering `undefined` for a missing entry. */
export async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return rethrowAsRefusal(error);
  }
}

/** Repeats the containment check on what the descriptor really points at (T5 step 5). */
export async function assertHandleInside(handle: FileHandle, root: string): Promise<void> {
  if (!isInside(root, await readlink(fdPath(handle)))) throw new PathRefusedError("outside-root");
}

/**
 * T5 step 5: opens without following a final symlink, lets only regular files and folders through,
 * then checks the descriptor's real path is still inside the root, which catches a parent folder
 * swapped for a symlink after resolving. The handle is closed on any refusal.
 */
export async function openVerified(root: string, absolute: string, intent: OpenIntent): Promise<FileHandle> {
  const handle = await openNoFollow(absolute, flags[intent]);
  try {
    assertKind(await handle.stat(), intent);
    await assertHandleInside(handle, root);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Opens with flags holding O_NOFOLLOW, refusing a symlink as `symlink` whatever errno Linux chose. */
export async function openNoFollow(path: string, openFlags: number): Promise<FileHandle> {
  try {
    return await open(path, openFlags);
  } catch (error) {
    // With O_DIRECTORY, a final symlink fails with ENOTDIR rather than ELOOP.
    if (errorCode(error) === "ENOTDIR" && (await lstatOrUndefined(path))?.isSymbolicLink() === true) {
      throw new PathRefusedError("symlink");
    }
    return rethrowAsRefusal(error);
  }
}

function assertKind(info: Stats, intent: OpenIntent): void {
  if (!info.isFile() && !info.isDirectory()) throw new PathRefusedError("special-file");
  if (intent === "folder" && !info.isDirectory()) throw new PathRefusedError("not-a-folder");
  if ((intent === "read" || intent === "write") && !info.isFile()) throw new PathRefusedError("not-a-file");
}
