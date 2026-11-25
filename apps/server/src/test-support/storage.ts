import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import type { RealPath } from "../modules/storage/index.ts";

/** Brands a path as real, for tests that build roots (or deliberately bad ones) by hand. */
export function asRealPath(path: string): RealPath {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests choose their roots, bad ones included.
  return path as RealPath;
}

/** A fresh real temp folder to use as a storage root, and its removal. */
export function makeStorageRoot(): { readonly dir: RealPath; cleanup(): void } {
  const dir = asRealPath(realpathSync(mkdtempSync(`${tmpdir()}/nu-storage-`)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

/** A listening Unix socket at `path`; close it when done. */
export async function makeSocket(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

/** Makes a character device at `path`; false where the runner may not (not root, no CAP_MKNOD). */
export function tryMakeDevice(path: string): boolean {
  try {
    execFileSync("mknod", [path, "c", "1", "3"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Upload content as an async stream of the given parts. */
export async function* byteChunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield Buffer.from(part, "utf8");
  }
}
