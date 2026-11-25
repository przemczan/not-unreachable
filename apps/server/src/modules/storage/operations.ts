import { constants, type Stats } from "node:fs";
import { link, mkdir, open, readdir, rename, rmdir, statfs, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode, NameRefusedError, NameTakenError, PathRefusedError } from "./errors.ts";
import { checkName } from "./names.ts";
import { assertHandleInside, fdPath, lstatOrUndefined, openNoFollow, openVerified } from "./open.ts";
import { assertContained, childRelative, resolveInResource } from "./resolve.ts";
import { WRITE_CHECK_PREFIX } from "./roots.ts";
import type { ContainedPath, Entry, EntryKind, FreeSpace, MoveIntoPlaceInput, NameConflict } from "./types.ts";

const { O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;

/** The temporary name an upload is written under before it's moved to its real name. */
const UPLOAD_PREFIX = ".nu-upload-";
const UPLOAD_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_KEEP_BOTH = 9999;
/** `link` errors from file systems without hard links (some SMB mounts); we fall back to a checked rename. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);
/** `fsync` errors from folders that can't be synced; the rename is still done. */
const NO_FOLDER_SYNC = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/** Opens an existing regular file (T5 steps 5–6): the caller reads or writes through the handle only. */
export async function openContained(path: ContainedPath, mode: "read" | "write"): Promise<FileHandle> {
  assertContained(path);
  return openVerified(path.root, path.absolute, mode);
}

/**
 * The folder's entries, sorted by name. Symlinks show as `link` and special files as `other`; none is
 * followed. Uploads in progress and write probes are hidden.
 */
export async function list(folder: ContainedPath): Promise<Entry[]> {
  assertContained(folder);
  return withFolder(folder.root, folder.absolute, async (handle) => {
    // Every call goes through the verified descriptor's /proc path, so a folder swapped after the
    // open can't redirect the listing.
    const names = (await readdir(fdPath(handle))).filter((name) => !name.startsWith(UPLOAD_PREFIX) && !name.startsWith(WRITE_CHECK_PREFIX));
    const entries = await Promise.all(
      names.map(async (name) => {
        const info = await lstatOrUndefined(fdPath(handle, name));
        return info === undefined ? undefined : toEntry(name, info);
      }),
    );
    return entries.filter((entry) => entry !== undefined).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  });
}

/** A file's or folder's entry; the root's has the name "". */
export async function stat(path: ContainedPath): Promise<Entry> {
  assertContained(path);
  const handle = await openVerified(path.root, path.absolute, "any");
  try {
    return toEntry(lastSegment(path), await handle.stat());
  } finally {
    await handle.close();
  }
}

/**
 * Makes a folder in `parent`; an existing folder is fine unless `mustBeNew` (then `NameTakenError`),
 * an existing symlink or file is refused.
 */
export async function makeFolder(parent: ContainedPath, name: string, { mustBeNew = false } = {}): Promise<ContainedPath> {
  assertContained(parent);
  const checked = acceptName(name);
  await withFolder(parent.root, parent.absolute, async (handle) => {
    const target = fdPath(handle, checked);
    try {
      await mkdir(target, { mode: 0o750 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await lstatOrUndefined(target);
      if (existing?.isSymbolicLink() === true) throw new PathRefusedError("symlink");
      if (existing?.isDirectory() !== true) throw new PathRefusedError("not-a-folder");
      if (mustBeNew) throw new NameTakenError();
    }
  });
  return resolveInResource(parent.root, childRelative(parent, checked));
}

/**
 * Removes a file, a symlink (never its target) or a folder with everything in it. Each folder is
 * opened without following and re-checked to be inside the root before anything in it is removed.
 */
export async function remove(path: ContainedPath): Promise<void> {
  assertContained(path);
  if (path.relative === "") throw new PathRefusedError("invalid");
  await withFolder(path.root, dirname(path.absolute), async (parent) => {
    if (!(await removeEntry(parent, lastSegment(path), path.root))) throw new PathRefusedError("not-found");
  });
}

/** Answers false if the entry was already gone. */
async function removeEntry(parent: FileHandle, name: string, root: string): Promise<boolean> {
  const at = fdPath(parent, name);
  const info = await lstatOrUndefined(at);
  if (info === undefined) return false;
  if (!info.isDirectory()) {
    await unlinkIfThere(at);
    return true;
  }
  const folder = await openNoFollow(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    await assertHandleInside(folder, root);
    for (const child of await readdir(fdPath(folder))) {
      await removeEntry(folder, child, root);
    }
  } finally {
    await folder.close();
  }
  await rmdir(at);
  return true;
}

/**
 * Writes an upload into `folder` under a temporary name, syncs it, then gives it its real name, so
 * no half-written file ever shows under it (domain.md, "Files and uploads").
 */
export async function moveIntoPlace(input: MoveIntoPlaceInput): Promise<ContainedPath> {
  const { folder, uploadId, content, onConflict } = input;
  assertContained(folder);
  const name = acceptName(input.name);
  if (!UPLOAD_ID.test(uploadId)) throw new PathRefusedError("invalid");
  const finalName = await withFolder(folder.root, folder.absolute, async (handle) => {
    const temp = fdPath(handle, `${UPLOAD_PREFIX}${uploadId}`);
    try {
      // A temp left by an earlier, interrupted try of the same upload; unlink never follows a symlink.
      await unlinkIfThere(temp);
      await writeTemp(temp, content);
      const placed = await place(handle, temp, name, onConflict);
      await syncFolder(handle);
      return placed;
    } catch (error) {
      await unlinkIfThere(temp);
      throw error;
    }
  });
  return resolveInResource(folder.root, childRelative(folder, finalName));
}

async function writeTemp(temp: string, content: AsyncIterable<Uint8Array>): Promise<void> {
  const handle = await open(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o640);
  try {
    for await (const chunk of content) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Gives the temp file its final name, by the conflict rule; answers the name it took. */
async function place(folder: FileHandle, temp: string, name: string, onConflict: NameConflict): Promise<string> {
  if (onConflict === "replace") {
    const existing = await lstatOrUndefined(fdPath(folder, name));
    if (existing !== undefined && !existing.isFile()) throw new NameTakenError();
    await rename(temp, fdPath(folder, name));
    return name;
  }
  for (const candidate of candidates(name, onConflict === "keep-both" ? MAX_KEEP_BOTH : 0)) {
    if (await linkWithoutReplacing(temp, fdPath(folder, candidate))) return candidate;
  }
  throw new NameTakenError();
}

/** `name`, then `name (1).ext`, `name (2).ext`… The extension is the last `.ext`; `.bashrc` has none. */
function* candidates(name: string, count: number): Generator<string> {
  yield name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n <= count; n += 1) {
    yield acceptName(`${stem} (${n})${extension}`);
  }
}

/**
 * `link` fails with EEXIST rather than replace, so a name taken at the last moment is never
 * clobbered; the temp name is then dropped. Without hard links, a re-checked rename leaves a tiny race.
 */
async function linkWithoutReplacing(temp: string, target: string): Promise<boolean> {
  try {
    await link(temp, target);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return false;
    if (!NO_HARD_LINKS.has(code ?? "")) throw error;
    if ((await lstatOrUndefined(target)) !== undefined) return false;
    await rename(temp, target);
    return true;
  }
  await unlink(temp);
  return true;
}

async function syncFolder(folder: FileHandle): Promise<void> {
  try {
    await folder.sync();
  } catch (error) {
    if (!NO_FOLDER_SYNC.has(errorCode(error) ?? "")) throw error;
  }
}

/**
 * The bytes of every regular file in the folder and below, for a quota. Symlinks are never followed
 * (nor counted), and each folder is opened without following and re-checked to be inside the root.
 */
export async function usedBytes(folder: ContainedPath): Promise<number> {
  assertContained(folder);
  return withFolder(folder.root, folder.absolute, (handle) => bytesIn(handle, folder.root));
}

async function bytesIn(folder: FileHandle, root: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(fdPath(folder))) {
    const at = fdPath(folder, name);
    const info = await lstatOrUndefined(at);
    if (info === undefined || info.isSymbolicLink()) continue;
    if (info.isFile()) {
      total += info.size;
    } else if (info.isDirectory()) {
      const child = await openNoFollow(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      try {
        await assertHandleInside(child, root);
        total += await bytesIn(child, root);
      } finally {
        await child.close();
      }
    }
  }
  return total;
}

/** Free and total bytes of the file system the path is on. */
export async function freeSpace(path: ContainedPath): Promise<FreeSpace> {
  assertContained(path);
  const handle = await openVerified(path.root, path.absolute, "any");
  try {
    const info = await statfs(fdPath(handle));
    return { availableBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  } finally {
    await handle.close();
  }
}

async function withFolder<T>(root: string, absolute: string, use: (handle: FileHandle) => Promise<T>): Promise<T> {
  const handle = await openVerified(root, absolute, "folder");
  try {
    return await use(handle);
  } finally {
    await handle.close();
  }
}

async function unlinkIfThere(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function acceptName(name: string): string {
  const checked = checkName(name);
  if (!checked.ok) throw new NameRefusedError(checked.reason);
  return checked.name;
}

function lastSegment(path: ContainedPath): string {
  return path.relative.slice(path.relative.lastIndexOf("/") + 1);
}

function toEntry(name: string, info: Stats): Entry {
  const kind = kindOf(info);
  return { name, kind, size: kind === "file" ? info.size : 0, modifiedAt: info.mtime.toISOString() };
}

function kindOf(info: Stats): EntryKind {
  if (info.isSymbolicLink()) return "link";
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "folder";
  return "other";
}
