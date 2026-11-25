/**
 * The storage module (domain.md, "Path safety"): the only way to reach files inside a resource.
 * It knows nothing about accounts, roles or resources: callers pass it a root and a relative path.
 *
 * Public functions:
 * - `resolveInResource(root: RealPath, relative: string): Promise<ContainedPath>` — T5 steps 1–6;
 *   throws `PathRefusedError`. The last segment may not exist yet (its parent must).
 * - `checkName(name: string): NameCheck` — T5 step 7.
 * - `fixRoot(absolute: string): Promise<FixedRoot>` — realpath, a folder, writable by the service.
 * - `canonicalPath(absolute: string): Promise<string>` — realpath of its deepest existing ancestor
 *   joined with the rest, for overlap checks against folders that may not exist.
 * - `openContained(path, mode: "read" | "write"): Promise<FileHandle>` — O_NOFOLLOW, fstat, fd re-check.
 * - `list(folder): Promise<Entry[]>`, `stat(path): Promise<Entry>`.
 * - `makeFolder(parent, name, { mustBeNew? }): Promise<ContainedPath>` — idempotent unless `mustBeNew`
 *   (`NameTakenError`); refuses an existing non-folder or symlink.
 * - `remove(path): Promise<void>` — recursive, never follows a symlink.
 * - `moveIntoPlace(input: MoveIntoPlaceInput): Promise<ContainedPath>` — throws `NameTakenError` for `refuse`.
 * - `freeSpace(path): Promise<FreeSpace>`.
 * - `usedBytes(folder): Promise<number>` — the regular files' bytes below it; never follows a symlink.
 */
export type {
  ContainedPath,
  Entry,
  EntryKind,
  FixedRoot,
  FreeSpace,
  MoveIntoPlaceInput,
  NameCheck,
  NameConflict,
  NameRefusal,
  PathRefusal,
  RealPath,
  RootRefusal,
} from "./types.ts";
export { PathRefusedError, NameRefusedError, NameTakenError } from "./errors.ts";
export { resolveInResource, isContainedPath } from "./resolve.ts";
export { checkName } from "./names.ts";
export { canonicalPath, fixRoot } from "./roots.ts";
export { freeSpace, list, makeFolder, moveIntoPlace, openContained, remove, stat, usedBytes } from "./operations.ts";
