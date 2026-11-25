import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SmbProtocol } from "@not-unreachable/contracts";
import { assertMountId } from "./mount-runner.ts";

/**
 * The app's side of the mount helper's request files (smb.md, "What happens underneath"), and the
 * one look at `/proc/self/mountinfo`: the only file system access of this module outside a
 * resource besides the systemd drop-in, hence its place on the lint rule's `node:fs` allowlist.
 */

export const DEFAULT_MOUNT_REQUESTS_DIR = "/run/not-unreachable/mount-requests";
export const MOUNT_INFO_PATH = "/proc/self/mountinfo";

/** What the helper reads; the password exists in clear text only here and in its credentials file. */
export interface MountRequest {
  readonly host: string;
  readonly share: string;
  /** "" for the share's top folder. */
  readonly subfolder: string;
  readonly username: string;
  readonly password: string;
  /** "" when the server needs none. */
  readonly domain: string;
  readonly vers: SmbProtocol;
  readonly seal: boolean;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function requestFile(dir: string, id: string): string {
  assertMountId(id);
  return join(dir, `${id}.json`);
}

/** Deletes the request file for `id`; nothing when there is none. */
export async function deleteMountRequest(dir: string, id: string): Promise<void> {
  try {
    await unlink(requestFile(dir, id));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Writes the request file for `id`, 0600, created exclusively (a stale one is deleted first). */
export async function writeMountRequest(dir: string, id: string, request: MountRequest): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Exclusive, so a symlink planted under the name is never followed: the write fails instead.
  await deleteMountRequest(dir, id);
  const handle = await open(requestFile(dir, id), "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(request), "utf8");
  } finally {
    await handle.close();
  }
}

/** One line of mountinfo: where something is mounted and its file system type. */
export interface MountInfoEntry {
  readonly mountPoint: string;
  readonly fsType: string;
}

/** The kernel's octal escapes (`\040` a space, `\011` a tab, `\012`, `\134` a backslash). */
function unescapeMountField(field: string): string {
  return field.replaceAll(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Parses `/proc/<pid>/mountinfo` (proc(5)): field 5 is the mount point, the type follows ` - `. */
export function parseMountInfo(content: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  for (const line of content.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    const mountPoint = fields[4];
    const fsType = fields[separator + 1];
    if (separator < 6 || mountPoint === undefined || fsType === undefined) continue;
    entries.push({ mountPoint: unescapeMountField(mountPoint), fsType });
  }
  return entries;
}

/** Whether `path` is a `cifs` mount now; the last mount on a path is the one in use. */
export async function isCifsMount(path: string, mountInfoPath: string = MOUNT_INFO_PATH): Promise<boolean> {
  const entries = parseMountInfo(await readFile(mountInfoPath, "utf8")).filter((entry) => entry.mountPoint === path);
  return entries.at(-1)?.fsType === "cifs";
}
