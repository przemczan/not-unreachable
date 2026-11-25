import { problemTypes } from "@not-unreachable/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpProblem } from "../../http/index.ts";
import { openContained, type ContainedPath } from "../storage/index.ts";

/*
 * Downloads (stack.md, "Downloads: HTTP Range, served by the app"): streamed from the file handle the
 * checked open gave (threat model, T5 step 6), one `bytes=` range at most, and always as an
 * attachment that never renders on our origin (T4, T7).
 */

/** A download's own CSP: nothing loads, and a browser that renders it anyway sandboxes it. */
export const DOWNLOAD_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** What a download needs of the open file's `fstat`. */
interface FileInfo {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtime: Date;
}

/** One inclusive byte range. */
interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** A strong validator: inode, size and modification time (ns), so any change makes a new one. */
function etagOf(info: FileInfo): string {
  const mtime = Math.round(info.mtimeMs * 1000);
  return `"${info.ino.toString(36)}-${info.size.toString(36)}-${mtime.toString(36)}"`;
}

/**
 * The range a `Range` header asks for: undefined to send the whole file (none, another unit,
 * several ranges or a malformed one, which RFC 9110 lets us ignore), or `unsatisfiable`.
 */
function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (match === null) return undefined;
  const specs = (match[1] ?? "").split(",");
  if (specs.length !== 1) return undefined;
  const spec = /^(\d*)-(\d*)$/.exec((specs[0] ?? "").trim());
  if (spec === null) return undefined;
  const [, first = "", last = ""] = spec;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

/** Whether `If-Range` still names this version: the same strong ETag, or the same Last-Modified second. */
function ifRangeHolds(header: string | undefined, etag: string, modified: Date): boolean {
  if (header === undefined) return true;
  const value = header.trim();
  if (value.startsWith('"') || value.startsWith("W/")) return value === etag;
  const date = Date.parse(value);
  return !Number.isNaN(date) && Math.floor(modified.getTime() / 1000) === Math.floor(date / 1000);
}

/** `Content-Disposition: attachment` with an ASCII fallback and the real name as RFC 8187 `filename*`. */
export function attachmentDisposition(name: string): string {
  const fallback = name.replaceAll(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(name).replaceAll(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** What a download is about to send, once its file is open and its range checked. */
export interface DownloadStart {
  readonly status: 200 | 206;
  /** The first byte sent: 0 for a whole file. */
  readonly start: number;
}

/**
 * Sends the file at `path` as a download: 200 whole, 206 for one satisfiable range, 416 (problem+json
 * with `Content-Range: bytes *\/size`) for an unsatisfiable one. Share links use it too, with
 * `onStart` to count a download: the promise this answers settles only once the whole body is sent
 * (it is the reply's own), so anything to do when the download starts must be done there.
 */
export async function sendContained(
  request: Pick<FastifyRequest, "headers">,
  reply: FastifyReply,
  path: ContainedPath,
  fileName: string = path.relative.slice(path.relative.lastIndexOf("/") + 1),
  onStart?: (start: DownloadStart) => void,
): Promise<FastifyReply> {
  const handle = await openContained(path, "read");
  let range: ByteRange | "unsatisfiable" | undefined;
  let info: FileInfo;
  let etag: string;
  try {
    info = await handle.stat();
    etag = etagOf(info);
    const requested = parseRange(single(request.headers.range), info.size);
    range = ifRangeHolds(single(request.headers["if-range"]), etag, info.mtime) ? requested : undefined;
    if (range === "unsatisfiable") {
      throw new HttpProblem(416, problemTypes.rangeNotSatisfiable, undefined, {
        "content-range": `bytes */${info.size}`,
        "accept-ranges": "bytes",
      });
    }
    onStart?.(range === undefined ? { status: 200, start: 0 } : { status: 206, start: range.start });
  } catch (error) {
    await handle.close();
    throw error;
  }
  reply.headers({
    "accept-ranges": "bytes",
    etag,
    "last-modified": info.mtime.toUTCString(),
    "content-type": "application/octet-stream",
    "content-disposition": attachmentDisposition(fileName),
    "x-content-type-options": "nosniff",
    "content-security-policy": DOWNLOAD_CSP,
  });
  if (range === undefined) {
    reply.header("content-length", String(info.size));
    return reply.code(200).send(handle.createReadStream({ autoClose: true }));
  }
  reply.header("content-length", String(range.end - range.start + 1));
  reply.header("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
  return reply.code(206).send(handle.createReadStream({ start: range.start, end: range.end, autoClose: true }));
}
