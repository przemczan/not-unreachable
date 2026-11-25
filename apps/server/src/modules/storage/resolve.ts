import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PathRefusedError } from "./errors.ts";
import { hasControlCharacter, MAX_SEGMENT_BYTES } from "./names.ts";
import { isInside, lstatOrUndefined, rethrowAsRefusal } from "./open.ts";
import type { ContainedPath, RealPath } from "./types.ts";

const MAX_PATH_BYTES = 4096;

/** Every `ContainedPath` this module made; anything else is a forgery. */
const made = new WeakSet<object>();

/** True only for a `ContainedPath` that `resolveInResource` made. */
export function isContainedPath(value: unknown): value is ContainedPath {
  return typeof value === "object" && value !== null && made.has(value);
}

/** Every operation calls this first, so a cast object can't reach the file system. */
export function assertContained(value: ContainedPath): void {
  if (!isContainedPath(value)) throw new TypeError("Not a ContainedPath made by resolveInResource");
}

/** The relative path of a name inside a folder. */
export function childRelative(folder: ContainedPath, name: string): string {
  return folder.relative === "" ? name : `${folder.relative}/${name}`;
}

/**
 * T5 steps 1–4: proves `relative` stays inside `root` and holds no symlink or special file. The last
 * segment may be missing (a name about to be made), its parent may not. Steps 5–6 happen when an
 * operation opens the result.
 */
export async function resolveInResource(root: RealPath, relative: string): Promise<ContainedPath> {
  const segments = parseRelative(relative);
  await assertRoot(root);
  let deepest: string = root;
  for (const [index, segment] of segments.entries()) {
    const next = join(deepest, segment);
    const info = await lstatOrUndefined(next);
    const last = index === segments.length - 1;
    if (info === undefined) {
      if (last) break;
      throw new PathRefusedError("not-found");
    }
    if (info.isSymbolicLink()) throw new PathRefusedError("symlink");
    if (!last && !info.isDirectory()) throw new PathRefusedError("not-a-folder");
    if (last && !info.isFile() && !info.isDirectory()) throw new PathRefusedError("special-file");
    deepest = next;
  }
  if (!isInside(root, await realOf(deepest))) throw new PathRefusedError("outside-root");
  return contain(root, segments.join("/"));
}

/** T5 step 1: refuses what can't be a safe relative path, and answers its NFC segments. */
function parseRelative(relative: string): string[] {
  // A UTF-16 length over the limit means more bytes too; checked first so a huge input costs nothing.
  if (relative.length > MAX_PATH_BYTES) throw new PathRefusedError("too-long");
  if (relative.includes("\\") || hasControlCharacter(relative) || !relative.isWellFormed() || relative.startsWith("/")) {
    throw new PathRefusedError("invalid");
  }
  const normal = relative.normalize("NFC");
  if (Buffer.byteLength(normal, "utf8") > MAX_PATH_BYTES) throw new PathRefusedError("too-long");
  const segments = normal.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new PathRefusedError("invalid");
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) throw new PathRefusedError("too-long");
  }
  return segments;
}

/** The root must still be the real folder it was when fixed: no symlink in it, anywhere. */
async function assertRoot(root: RealPath): Promise<void> {
  if (!isAbsolute(root)) throw new PathRefusedError("invalid");
  const info = await lstatOrUndefined(root);
  if (info === undefined) throw new PathRefusedError("not-found");
  if (info.isSymbolicLink()) throw new PathRefusedError("symlink");
  if (!info.isDirectory()) throw new PathRefusedError("not-a-folder");
  if ((await realOf(root)) !== root) throw new PathRefusedError("outside-root");
}

async function realOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    return rethrowAsRefusal(error);
  }
}

/** The only place a `ContainedPath` is made, and so the only place its brands are asserted. */
function contain(root: RealPath, relative: string): ContainedPath {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a child of a real root, walked without symlinks.
  const absolute = (relative === "" ? root : join(root, relative)) as RealPath;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand is compile-time only; `made` is the run-time proof.
  const path = Object.freeze({ root, relative, absolute }) as ContainedPath;
  made.add(path);
  return path;
}
