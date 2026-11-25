import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * The app's side of the folder helper's request file (deployment.md, "Allowing folders from the
 * admin interface"): one file, as the helper allows one folder per run. With the mount helper's
 * requests, the only file system access of this module outside a resource, hence its place on the
 * lint rule's `node:fs` allowlist.
 */

export const DEFAULT_FOLDER_REQUESTS_DIR = "/run/not-unreachable/folder-requests";
export const FOLDER_REQUEST_FILE = "allow-folder.json";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Deletes the request file; nothing when there is none. */
export async function deleteFolderRequest(dir: string): Promise<void> {
  try {
    await unlink(join(dir, FOLDER_REQUEST_FILE));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Writes the request for `path`, as the admin typed it: 0600, created exclusively (a stale one is deleted first). */
export async function writeFolderRequest(dir: string, path: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Exclusive, so a symlink planted under the name is never followed: the write fails instead.
  await deleteFolderRequest(dir);
  const handle = await open(join(dir, FOLDER_REQUEST_FILE), "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ path }), "utf8");
  } finally {
    await handle.close();
  }
}
