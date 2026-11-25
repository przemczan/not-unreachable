import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { errorCode } from "./errors.ts";
import type { FixedRoot, RealPath } from "./types.ts";

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;
const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);
/**
 * `realpath` errors from a folder the service can't even reach, such as one under `/home` while
 * `ProtectHome=yes` hides it: as good as not writable, which `allow-folder` fixes.
 */
const NOT_REACHABLE = new Set(["EACCES", "EPERM"]);

/** The temp-file prefix of the write probe; listings hide it. */
export const WRITE_CHECK_PREFIX = ".nu-write-check-";

/**
 * Fixes a folder as a root (T5 step 2): its real path, once it's proved to be a folder the service
 * can write to. Callers store `realPath` and re-check it at startup.
 */
export async function fixRoot(absolute: string): Promise<FixedRoot> {
  if (!isAbsolute(absolute)) return { ok: false, reason: "not-absolute" };
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    if (code === "ENOTDIR") return { ok: false, reason: "not-a-folder" };
    if (NOT_REACHABLE.has(code ?? "")) return { ok: false, reason: "not-writable" };
    throw error;
  }
  if (!(await stat(real)).isDirectory()) return { ok: false, reason: "not-a-folder" };
  if (!(await canWrite(real))) return { ok: false, reason: "not-writable" };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `realpath` answered it.
  return { ok: true, realPath: real as RealPath };
}

/** Creates and removes a uniquely named file: the only sure test, as permissions alone miss read-only mounts. */
async function canWrite(folder: string): Promise<boolean> {
  const probe = join(folder, `${WRITE_CHECK_PREFIX}${randomBytes(8).toString("hex")}`);
  try {
    const handle = await open(probe, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (error) {
    if (NOT_WRITABLE.has(errorCode(error) ?? "")) return false;
    throw error;
  }
  await unlink(probe);
  return true;
}

/**
 * The real path of `absolute`'s deepest existing (and reachable) ancestor joined with the segments
 * below it, so two folders can be compared for overlap even when one doesn't exist yet.
 */
export async function canonicalPath(absolute: string): Promise<string> {
  let current = resolve(absolute);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (error) {
      const code = errorCode(error) ?? "";
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR" && !NOT_REACHABLE.has(code)) || parent === current) throw error;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}
