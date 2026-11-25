/**
 * Reading a release tarball (deployment.md, "Updating from Settings", step 5): gzip, then ustar and
 * pax headers only, with no `tar` binary. The update helper runs it as root on a tarball whose
 * signature and checksum already passed, so the rules are a second line: a tar implementation's
 * quirks (links, devices, names that climb out) never reach the file system.
 *
 * Pass 1 (`checkReleaseArchive`) checks every entry and reads `VERSION` and `ARCH`; pass 2
 * (`unpackReleaseArchive`) checks them again as it unpacks. Both stream the archive.
 *
 * It imports only `node:` built-ins: the helpers run as root and ship as built files alone.
 */
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, symlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { createGunzip } from "node:zlib";

/** What an archive is refused for; each is one of the update reasons. */
export type ArchiveProblem = "archive-unsafe" | "archive-invalid";

export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
  readonly problem: ArchiveProblem;

  constructor(problem: ArchiveProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
export const MAX_ENTRIES = 200_000;
const BLOCK = 512;
const MAX_PAX_HEADER_BYTES = 64 * 1024;
// Headers, pax records and padding on top of the files themselves; past this the stream is a bomb.
const MAX_STREAM_BYTES = MAX_UNPACKED_BYTES + MAX_ENTRIES * 4 * BLOCK;
// VERSION and ARCH are one short line each; more is kept only to tell that it is more.
const MAX_RELEASE_FILE_BYTES = 256;

const unsafe = (message: string): ArchiveError => new ArchiveError("archive-unsafe", message);
const invalid = (message: string): ArchiveError => new ArchiveError("archive-invalid", message);

/** The decompressed tar stream, read in blocks and runs of bytes. */
class TarStream {
  private readonly chunks: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private total = 0;

  constructor(chunks: AsyncIterator<Buffer>) {
    this.chunks = chunks;
  }

  private async fill(): Promise<boolean> {
    let next: IteratorResult<Buffer>;
    try {
      next = await this.chunks.next();
    } catch {
      throw invalid("the archive is not gzip, or is corrupt");
    }
    if (next.done === true) return false;
    this.total += next.value.byteLength;
    if (this.total > MAX_STREAM_BYTES) throw unsafe("the archive unpacks to more than 1 GiB");
    this.pending = this.pending.byteLength === 0 ? next.value : Buffer.concat([this.pending, next.value]);
    return true;
  }

  /** The next 512-byte block, or undefined at the end of the stream. */
  async block(): Promise<Buffer | undefined> {
    while (this.pending.byteLength < BLOCK) {
      if (!(await this.fill())) {
        if (this.pending.byteLength === 0) return undefined;
        throw invalid("the archive is truncated");
      }
    }
    const block = this.pending.subarray(0, BLOCK);
    this.pending = this.pending.subarray(BLOCK);
    return block;
  }

  /** Hands the next `length` bytes to `each`, a piece at a time, then skips the padding to the next block. */
  async read(length: number, each: (piece: Buffer) => Promise<void> | void): Promise<void> {
    const padded = length + ((BLOCK - (length % BLOCK)) % BLOCK);
    let remaining = padded;
    while (remaining > 0) {
      if (this.pending.byteLength === 0 && !(await this.fill())) throw invalid("the archive is truncated");
      const take = Math.min(remaining, this.pending.byteLength);
      const piece = this.pending.subarray(0, take);
      this.pending = this.pending.subarray(take);
      const offset = padded - remaining;
      if (offset < length) await each(piece.subarray(0, Math.min(take, length - offset)));
      remaining -= take;
    }
  }
}

// --- Headers ------------------------------------------------------------------------------------

type EntryType = "file" | "directory" | "symlink";

interface Entry {
  readonly name: string;
  readonly type: EntryType;
  readonly size: number;
  readonly executable: boolean;
  readonly linkTarget: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function text(field: Buffer): string {
  const end = field.indexOf(0);
  try {
    return decoder.decode(end === -1 ? field : field.subarray(0, end));
  } catch {
    throw unsafe("an entry's name is not UTF-8");
  }
}

function octal(field: Buffer, what: string): number {
  const value = field
    .toString("latin1")
    .replaceAll(/[\0 ]+$/gu, "")
    .replace(/^ +/u, "");
  if (!/^[0-7]{1,12}$/u.test(value)) throw invalid(`a header's ${what} is not an octal number`);
  return Number.parseInt(value, 8);
}

function checksumMatches(header: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  return sum === octal(header.subarray(148, 156), "checksum");
}

const TYPE_REFUSALS: Readonly<Record<string, string>> = {
  "1": "a hard link",
  "3": "a character device",
  "4": "a block device",
  "6": "a FIFO",
};

/** The pax records that matter here: `path`, `linkpath` and `size`. */
interface PaxOverrides {
  path?: string;
  linkpath?: string;
  size?: number;
}

function parsePax(content: Buffer): PaxOverrides {
  const overrides: PaxOverrides = {};
  let position = 0;
  while (position < content.byteLength) {
    const space = content.indexOf(0x20, position);
    const lengthText = space === -1 ? "" : content.toString("latin1", position, space);
    if (!/^[1-9]\d{0,6}$/u.test(lengthText)) throw invalid("a pax record is malformed");
    const end = position + Number(lengthText);
    if (end > content.byteLength || content[end - 1] !== 0x0a) throw invalid("a pax record is malformed");
    let record: string;
    try {
      record = decoder.decode(content.subarray(space + 1, end - 1));
    } catch {
      throw unsafe("a pax record is not UTF-8");
    }
    const equals = record.indexOf("=");
    if (equals <= 0) throw invalid("a pax record is malformed");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") overrides.path = value;
    else if (key === "linkpath") overrides.linkpath = value;
    else if (key === "size") {
      if (!/^\d{1,15}$/u.test(value)) throw invalid("a pax size is not a number");
      overrides.size = Number(value);
    } else if (key.startsWith("GNU.sparse.")) throw unsafe("a sparse file");
    position = end;
  }
  return overrides;
}

/**
 * The next entry, its pax header folded in; undefined at the end-of-archive marker, after which
 * only zeros may follow.
 */
async function nextEntry(stream: TarStream): Promise<Entry | undefined> {
  let pax: PaxOverrides | undefined;
  for (;;) {
    const header = await stream.block();
    if (header === undefined) throw invalid("the archive ends without its end marker");
    if (header.every((byte) => byte === 0)) {
      if (pax !== undefined) throw invalid("a pax header precedes the end marker");
      await expectOnlyZeros(stream);
      return undefined;
    }
    if (!checksumMatches(header)) throw invalid("a header's checksum doesn't match");
    if (header.toString("latin1", 257, 263) !== "ustar\0" || header.toString("latin1", 263, 265) !== "00") {
      throw invalid("a header is not ustar or pax");
    }
    const typeflag = header.toString("latin1", 156, 157);
    const headerSize = octal(header.subarray(124, 136), "size");
    if (typeflag === "x") {
      if (pax !== undefined) throw invalid("two pax headers in a row");
      if (headerSize > MAX_PAX_HEADER_BYTES) throw unsafe("a pax header is too large");
      const pieces: Buffer[] = [];
      await stream.read(headerSize, (piece) => {
        pieces.push(Buffer.from(piece));
      });
      pax = parsePax(Buffer.concat(pieces));
      continue;
    }
    const refusal = TYPE_REFUSALS[typeflag];
    if (refusal !== undefined) throw unsafe(`the archive holds ${refusal}`);
    const type: EntryType | undefined =
      typeflag === "0" || typeflag === "\0" ? "file" : typeflag === "5" ? "directory" : typeflag === "2" ? "symlink" : undefined;
    if (type === undefined) throw unsafe(`the archive holds an entry of type ${JSON.stringify(typeflag)}`);

    const mode = octal(header.subarray(100, 108), "mode");
    if ((mode & 0o7000) !== 0) throw unsafe("an entry has a setuid, setgid or sticky bit");
    const prefix = text(header.subarray(345, 500));
    const ustarName = prefix === "" ? text(header.subarray(0, 100)) : `${prefix}/${text(header.subarray(0, 100))}`;
    const size = pax?.size ?? headerSize;
    if (type !== "file" && size !== 0) throw invalid("a directory or symlink has a size");
    return {
      name: pax?.path ?? ustarName,
      type,
      size,
      executable: (mode & 0o111) !== 0,
      linkTarget: pax?.linkpath ?? text(header.subarray(157, 257)),
    };
  }
}

async function expectOnlyZeros(stream: TarStream): Promise<void> {
  for (;;) {
    const block = await stream.block();
    if (block === undefined) return;
    if (!block.every((byte) => byte === 0)) throw invalid("data follows the end marker");
  }
}

// --- The rules ----------------------------------------------------------------------------------

/** An entry's name as components below the archive's root, once it is known to be safe. */
function components(entry: Entry, top: string): string[] {
  const name = entry.type === "directory" && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
  if (name.includes("\0")) throw unsafe("an entry's name holds a NUL");
  if (name.startsWith("/")) throw unsafe("an entry has an absolute name");
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw unsafe("an entry's name has an empty, . or .. component");
  if (parts[0] !== top) throw unsafe(`an entry lies outside ${top}/`);
  if (parts.length === 1 && entry.type !== "directory") throw unsafe(`${top} is not a folder`);
  return parts;
}

/**
 * A symlink may only be one `pnpm deploy` writes: under `<top>/release/node_modules/`, with a
 * relative target that stays inside `<top>/release/`. The target is some `..` components, then
 * plain names: `..` is then applied to the link's own folder, a real one (no entry lies below a
 * symlink), so resolving by name is what the kernel does, and a name that is itself a symlink
 * leads only to another place inside `release/`.
 */
function checkSymlink(parts: readonly string[], target: string, top: string): void {
  const name = parts.join("/");
  const release = `${top}/release`;
  if (!name.startsWith(`${release}/node_modules/`)) throw unsafe("a symlink lies outside release/node_modules/");
  if (target === "" || target.includes("\0") || target.startsWith("/"))
    throw unsafe("a symlink's target is empty, absolute or holds a NUL");
  const targetParts = target.split("/");
  const firstName = targetParts.findIndex((part) => part !== "..");
  const names = firstName === -1 ? [] : targetParts.slice(firstName);
  if (names.some((part) => part === "" || part === "." || part === "..")) throw unsafe("a symlink's target is not ../ then names");
  const resolved = posix.normalize(posix.join(posix.dirname(name), target));
  if (resolved !== release && !resolved.startsWith(`${release}/`)) throw unsafe("a symlink's target leaves release/");
}

/** The checks across entries: count, size, duplicates, and nothing below a file or a symlink. */
class ArchiveRules {
  private readonly top: string;
  private readonly kinds = new Map<string, EntryType | "implicit">();
  private entries = 0;
  private bytes = 0;

  constructor(top: string) {
    this.top = top;
  }

  /** The entry's path below the archive's root, once every rule allows it. */
  check(entry: Entry): string {
    this.entries += 1;
    if (this.entries > MAX_ENTRIES) throw unsafe(`the archive holds more than ${MAX_ENTRIES} entries`);
    this.bytes += entry.size;
    if (this.bytes > MAX_UNPACKED_BYTES) throw unsafe("the archive unpacks to more than 1 GiB");
    const parts = components(entry, this.top);
    const path = parts.join("/");
    const known = this.kinds.get(path);
    if (known !== undefined && !(known === "implicit" && entry.type === "directory")) throw unsafe(`${path} is in the archive twice`);
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join("/");
      const kind = this.kinds.get(parent);
      if (kind === "file" || kind === "symlink") throw unsafe(`${path} lies below a file or symlink`);
      if (kind === undefined) this.kinds.set(parent, "implicit");
    }
    if (entry.type === "symlink") checkSymlink(parts, entry.linkTarget, this.top);
    this.kinds.set(path, entry.type);
    return path;
  }
}

// --- The passes ---------------------------------------------------------------------------------

async function eachEntry(
  tarball: string,
  top: string,
  each: (entry: Entry, path: string, stream: TarStream) => Promise<void>,
): Promise<void> {
  const gunzip = createReadStream(tarball).pipe(createGunzip());
  const stream = new TarStream(gunzip[Symbol.asyncIterator]());
  const rules = new ArchiveRules(top);
  try {
    for (;;) {
      const entry = await nextEntry(stream);
      if (entry === undefined) return;
      const path = rules.check(entry);
      await each(entry, path, stream);
    }
  } finally {
    gunzip.destroy();
  }
}

/** `VERSION` and `ARCH` of the archive's top folder, without their final newline; undefined when absent. */
export interface ReleaseIdentity {
  readonly version: string | undefined;
  readonly arch: string | undefined;
}

function releaseFileText(pieces: readonly Buffer[]): string {
  try {
    return decoder.decode(Buffer.concat(pieces)).replace(/\n$/u, "");
  } catch {
    return "";
  }
}

/** Pass 1: checks every entry of the archive whose one top folder is `top`, and reads `VERSION` and `ARCH`. */
export async function checkReleaseArchive(tarball: string, top: string): Promise<ReleaseIdentity> {
  const found = new Map<string, string>();
  const wanted = new Set([`${top}/VERSION`, `${top}/ARCH`]);
  await eachEntry(tarball, top, async (entry, path, stream) => {
    const pieces: Buffer[] = [];
    let kept = 0;
    await stream.read(entry.size, (piece) => {
      if (!wanted.has(path) || entry.type !== "file" || kept > MAX_RELEASE_FILE_BYTES) return;
      pieces.push(Buffer.from(piece));
      kept += piece.byteLength;
    });
    if (wanted.has(path) && entry.type === "file") found.set(path, kept > MAX_RELEASE_FILE_BYTES ? "" : releaseFileText(pieces));
  });
  return { version: found.get(`${top}/VERSION`), arch: found.get(`${top}/ARCH`) };
}

/**
 * Pass 2: unpacks the archive into `target`, an empty folder, as root's files: folders `0755`,
 * files `0644` or `0755` when the archive marks them executable. Each file is made with O_EXCL and
 * O_NOFOLLOW, so nothing already there, a symlink least of all, is written through.
 */
export async function unpackReleaseArchive(tarball: string, top: string, target: string): Promise<void> {
  const folders = new Set<string>();
  await eachEntry(tarball, top, async (entry, path, stream) => {
    const destination = join(target, path);
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join("/");
      if (!folders.has(parent)) {
        await makeFolder(join(target, parent));
        folders.add(parent);
      }
    }
    if (entry.type === "directory") {
      if (!folders.has(path)) await makeFolder(destination);
      folders.add(path);
      return;
    }
    if (entry.type === "symlink") {
      await symlink(entry.linkTarget, destination);
      return;
    }
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await stream.read(entry.size, async (piece) => {
        await handle.write(piece);
      });
      await handle.chmod(entry.executable ? 0o755 : 0o644);
    } finally {
      await handle.close();
    }
  });
}

async function makeFolder(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (error) {
    // A folder made for an entry below it, before the folder's own entry.
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || !(await lstat(path)).isDirectory()) throw error;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.chmod(0o755);
  } finally {
    await handle.close();
  }
}
