declare const realPathBrand: unique symbol;
declare const containedPathBrand: unique symbol;

/** An absolute path with no symlink in it, as `realpath` answers it: a resource's root or a home. */
export type RealPath = string & { readonly [realPathBrand]: true };

/**
 * A path proved to stay inside its root (threat model, T5). Only `resolveInResource` makes one, and
 * every file operation of this module accepts nothing else, at compile time (the brand) and at run
 * time (a registry of the values it made).
 */
export interface ContainedPath {
  readonly root: RealPath;
  /** Relative to the root, NFC, with `/` between segments; empty for the root itself. */
  readonly relative: string;
  readonly absolute: RealPath;
  readonly [containedPathBrand]: true;
}

/** How a listing shows an entry. A symlink is listed as `link` and never followed. */
export type EntryKind = "file" | "folder" | "link" | "other";

export interface Entry {
  readonly name: string;
  readonly kind: EntryKind;
  /** Bytes, for a file; 0 otherwise. */
  readonly size: number;
  readonly modifiedAt: string;
}

/** Why `resolveInResource` (or an operation re-checking a path) refused it. */
export type PathRefusal =
  "invalid" | "too-long" | "symlink" | "outside-root" | "special-file" | "not-found" | "not-a-folder" | "not-a-file";

/** Why `checkName` refused a new name (T5, step 7). */
export type NameRefusal =
  "empty" | "dot" | "slash" | "too-long" | "trailing-dot-or-space" | "reserved-name" | "reserved-character" | "control-character";

export type NameCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: NameRefusal };

/** Why `fixRoot` refused a folder as a root. */
export type RootRefusal = "not-absolute" | "missing" | "not-a-folder" | "not-writable";

export type FixedRoot = { readonly ok: true; readonly realPath: RealPath } | { readonly ok: false; readonly reason: RootRefusal };

/** What `moveIntoPlace` does when the name is taken: overwrite it, take `name (n).ext`, or refuse. */
export type NameConflict = "replace" | "keep-both" | "refuse";

export interface MoveIntoPlaceInput {
  /** The folder the file goes into. */
  readonly folder: ContainedPath;
  /** Checked with `checkName`. */
  readonly name: string;
  /** Names the temporary `.nu-upload-<uploadId>` file. */
  readonly uploadId: string;
  readonly content: AsyncIterable<Uint8Array>;
  readonly onConflict: NameConflict;
}

export interface FreeSpace {
  readonly availableBytes: number;
  readonly totalBytes: number;
}
