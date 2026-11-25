import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { updateStatusFileSchema, type UpdateStatusFile } from "@not-unreachable/contracts";

/**
 * The updates module's file system access (deployment.md, "Updating from Settings"), all outside
 * every resource, hence its place on the lint rule's `node:fs` allowlist: the spool the server
 * downloads a release into, the update helper's request file, and the helper's status file, which
 * the server only reads.
 */

export const SPOOL_FOLDER = "updates";
export const DEFAULT_UPDATE_REQUESTS_DIR = "/run/not-unreachable/update-requests";
export const UPDATE_REQUEST_FILE = "update.json";
export const DEFAULT_STATUS_FILE = "/var/lib/not-unreachable-update/status.json";
/** The status file is a few hundred bytes; anything far larger isn't the helper's. */
const MAX_STATUS_BYTES = 64 * 1024;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Empties the spool, making it (0700) when it isn't there. */
export async function emptySpool(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Writes `name` beside itself (`<name>.part`, 0600, created exclusively), then renames it once complete. */
export async function writeSpoolFile(dir: string, name: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  const part = join(dir, `${name}.part`);
  const handle = await open(part, "wx", 0o600);
  try {
    try {
      for await (const chunk of chunks) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    await rename(part, join(dir, name));
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/** A spool file the server itself wrote, for the early check. */
export async function readSpoolFile(dir: string, name: string): Promise<Buffer> {
  return readFile(join(dir, name));
}

/** Deletes the request file; nothing when there is none. */
export async function deleteUpdateRequest(dir: string): Promise<void> {
  try {
    await unlink(join(dir, UPDATE_REQUEST_FILE));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Writes `{"requestId", "version"}` and nothing else: 0600, created exclusively (a stale one is deleted first). */
export async function writeUpdateRequest(dir: string, requestId: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Exclusive, so a symlink planted under the name is never followed: the write fails instead.
  await deleteUpdateRequest(dir);
  const handle = await open(join(dir, UPDATE_REQUEST_FILE), "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ requestId, version }), "utf8");
  } finally {
    await handle.close();
  }
}

/** The status file as the server reads it: none yet, one that doesn't parse (never trusted), or its status. */
export type StatusFileRead =
  { readonly kind: "absent" } | { readonly kind: "unknown" } | { readonly kind: "known"; readonly status: UpdateStatusFile };

export async function readStatusFile(file: string): Promise<StatusFileRead> {
  let content: Buffer;
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_STATUS_BYTES) return { kind: "unknown" };
      content = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : { kind: "unknown" };
  }
  try {
    const parsed = updateStatusFileSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
    return parsed.success ? { kind: "known", status: parsed.data } : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}
