import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { MASTER_KEY_BYTES } from "./secrets.ts";

/** Where install puts the master key (deployment.md); the service reads it via `$CREDENTIALS_DIRECTORY`. */
export const DEFAULT_MASTER_KEY_FILE = "/etc/not-unreachable/credentials/master.key";
export const MASTER_KEY_CREDENTIAL = "master.key";

/** Thrown when the master key can't be loaded; the message names the problem, never the key's bytes. */
export class MasterKeyError extends Error {
  override readonly name = "MasterKeyError";
}

/** Reads `$CREDENTIALS_DIRECTORY/master.key` (systemd `LoadCredential=`). */
export function loadMasterKey(environment: NodeJS.ProcessEnv): Buffer {
  const directory = environment["CREDENTIALS_DIRECTORY"];
  if (directory === undefined || directory.trim() === "") {
    throw new MasterKeyError(
      `CREDENTIALS_DIRECTORY is not set: the service needs the ${MASTER_KEY_CREDENTIAL} credential (systemd LoadCredential=)`,
    );
  }
  return readMasterKeyFile(join(directory, MASTER_KEY_CREDENTIAL));
}

/** Reads a master key file: exactly 32 bytes. */
export function readMasterKeyFile(path: string): Buffer {
  let key: Buffer;
  try {
    key = readFileSync(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    const reason = code === "ENOENT" ? "does not exist" : `cannot be read (${code ?? "unknown error"})`;
    throw new MasterKeyError(`The master key file ${path} ${reason}`);
  }
  if (key.length !== MASTER_KEY_BYTES) {
    const length = key.length;
    key.fill(0);
    throw new MasterKeyError(`The master key file ${path} must hold exactly ${MASTER_KEY_BYTES} bytes, it holds ${length}`);
  }
  return key;
}

export function generateMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES);
}

/** Writes a key file with mode 0600 atomically (temp file, fsync, rename), replacing any file at `path`. */
export function writeKeyFile(path: string, key: Uint8Array): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, key);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export interface KeyFileNames {
  readonly current: string;
  readonly next: string;
  readonly previous: string;
}

export function keyFileNames(keyFile: string): KeyFileNames {
  return { current: keyFile, next: `${keyFile}.new`, previous: `${keyFile}.previous` };
}

/** After a successful rotation: `master.key` → `master.key.previous`, `master.key.new` → `master.key`. */
export function promoteNewKeyFile(names: KeyFileNames): void {
  renameSync(names.current, names.previous);
  renameSync(names.next, names.current);
}
