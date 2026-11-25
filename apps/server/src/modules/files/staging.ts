import { createReadStream, mkdirSync } from "node:fs";
import { chmod, readdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileStore } from "@tus/file-store";
import type { KvStore, Upload } from "@tus/utils";
import type { FreeSpace } from "../storage/index.ts";

/*
 * The upload staging area, `DATA_DIR/uploads` (threat model, T7): outside every resource and the web
 * root, folder 0700, files 0600. The only file of the files module that touches the file system
 * itself; it never reaches into a resource (the storage module does that).
 */

/** A staged file's name is its upload's id, a UUIDv7; nothing else in the folder is ours to touch. */
const STAGED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * tus's file store, writing each staged file with mode 0600, with only the extensions we allow: no
 * deferred length, no creation-with-upload and no expiration (our cleanup job expires uploads).
 */
class StagingStore extends FileStore {
  constructor(directory: string, configstore: KvStore) {
    // Made here, 0700; the base class's own mkdir (mode 0777, throwing from a callback) is skipped below.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    super({ directory, configstore });
    this.extensions = ["creation", "termination"];
  }

  override async create(file: Upload): Promise<Upload> {
    const path = stagedFile(this.directory, file.id);
    await writeFile(path, "", { mode: 0o600, flag: "wx" });
    // The umask can only take bits away; chmod makes it exactly 0600 whatever it was.
    await chmod(path, 0o600);
    await this.configstore.set(file.id, file);
    file.storage = { type: "file", path };
    return file;
  }
}

// The base constructor calls this private method; ours makes the folder itself, synchronously.
Object.defineProperty(StagingStore.prototype, "checkOrCreateDirectory", { value: () => undefined });

function stagedFile(directory: string, id: string): string {
  if (!STAGED_NAME.test(id)) throw new Error("Not an upload id");
  return join(directory, id);
}

export interface StagingArea {
  readonly directory: string;
  /** tus's data store over the folder, made on first use (it makes the folder). */
  store(): FileStore;
  /** Where the upload's bytes are staged. */
  pathOf(id: string): string;
  /** The staged bytes, for moving them into place. */
  read(id: string): AsyncIterable<Uint8Array>;
  /** Deletes the staged file; nothing when it is already gone. */
  remove(id: string): Promise<void>;
  /** The upload ids that have a staged file. */
  list(): Promise<string[]>;
  /** Free and total bytes of the disk the folder is on. */
  freeSpace(): Promise<FreeSpace>;
}

export function createStagingArea(directory: string, configstore: KvStore): StagingArea {
  let store: StagingStore | undefined;
  return {
    directory,
    store() {
      store ??= new StagingStore(directory, configstore);
      return store;
    },
    pathOf: (id) => stagedFile(directory, id),
    read: (id) => createReadStream(stagedFile(directory, id)),
    async remove(id) {
      try {
        await unlink(stagedFile(directory, id));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    },
    async list() {
      try {
        return (await readdir(directory)).filter((name) => STAGED_NAME.test(name));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
    },
    async freeSpace() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = await statfs(directory);
      return { availableBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
    },
  };
}
