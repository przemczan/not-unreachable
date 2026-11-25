import { UPLOAD_CHUNK_BYTES, problemSchema, problemTypes, type UploadConflictChoice } from "@not-unreachable/contracts";
import { Upload, defaultOptions, type DetailedError } from "tus-js-client";
import { ApiError, REQUEST_MARKER_HEADER } from "../api/index.ts";
import { problemMessage } from "../lib/index.ts";

/** Where tus creates uploads (contracts, createUpload). */
export const UPLOAD_ENDPOINT = "/api/v1/uploads";

/** Uploads sent at once; the rest wait, so the server's per-account limit is rarely met. */
export const MAX_ACTIVE_UPLOADS = 3;

type UploadOptions = NonNullable<ConstructorParameters<typeof Upload>[1]>;
type UrlStorage = NonNullable<UploadOptions["urlStorage"]>;
type PreviousUpload = Awaited<ReturnType<UrlStorage["findAllUploads"]>>[number];

/** Remembers nothing: no upload resumes after a reload. */
const noUrlStorage: UrlStorage = {
  findAllUploads: () => Promise.resolve([]),
  findUploadsByFingerprint: () => Promise.resolve([]),
  removeUpload: () => Promise.resolve(),
  addUpload: () => Promise.resolve(""),
};

/**
 * tus-js-client's default storage, or `noUrlStorage` where that is its own fallback (no usable
 * localStorage, such as Safari's private mode, or its Node build), which lacks `findAllUploads`.
 */
function defaultUrlStorage(): UrlStorage {
  const storage = defaultOptions.urlStorage;
  return "findAllUploads" in storage ? storage : noUrlStorage;
}

/** Where an upload goes: a folder of the user's home, or (the admin) of a resource. */
export interface UploadTarget {
  /** The folder, "" for the top one. */
  readonly folder: string;
  /** The admin's resource; left out for a user's home. */
  readonly resourceId?: string | undefined;
}

export type UploadState = "queued" | "uploading" | "paused" | "done" | "failed";

/** One upload, as the queue and the file browser see it. */
export interface UploadRecord extends UploadTarget {
  readonly id: string;
  readonly name: string;
  readonly bytesSent: number;
  readonly bytesTotal: number;
  readonly state: UploadState;
  /** Why it failed or stopped, in words. */
  readonly error?: string | undefined;
  /** The name is taken in the folder: waiting for Replace or Keep both (`resolveConflict`). */
  readonly conflict: boolean;
  /** Left unfinished before the page was reloaded: it resumes when the same file is chosen again. */
  readonly needsFile: boolean;
}

export interface UploadDoneEvent {
  readonly type: "done";
  readonly upload: UploadRecord;
}

export interface UploadStore {
  /** The uploads, in the order they were added; a new array after every change. */
  getSnapshot: () => readonly UploadRecord[];
  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Calls `listener` when an upload finishes; returns the unsubscribe. */
  onDone: (listener: (event: UploadDoneEvent) => void) => () => void;
  /**
   * Uploads files into a folder. A file matching an upload left unfinished before a reload (same
   * name and size) resumes that upload, into its own folder, instead.
   */
  add: (files: readonly File[], target: UploadTarget) => void;
  /** Stops sending; what was sent stays on the server. */
  pause: (id: string) => void;
  /** Continues a paused or stopped upload (not one that needs its file chosen again). */
  resume: (id: string) => void;
  /** Stops and deletes what was sent (tus termination), and drops the upload from the list. */
  cancel: (id: string) => void;
  /** Starts a name-taken upload again, replacing the file or keeping both. */
  resolveConflict: (id: string, choice: Exclude<UploadConflictChoice, "fail">) => void;
  /** Drops the finished and failed uploads from the list. */
  clearFinished: () => void;
  /** Lists the unfinished uploads of an earlier page load, as paused ones that need their file. */
  restore: () => Promise<void>;
}

interface Entry {
  record: UploadRecord;
  file?: File;
  upload?: Upload;
  previous?: PreviousUpload;
  onConflict: UploadConflictChoice;
}

export interface UploadStoreOptions {
  /** Whose uploads these are: the stored ones of other accounts in this browser are left alone. */
  readonly accountId: string;
  /** Where tus remembers unfinished uploads; the browser's localStorage by default. */
  readonly urlStorage?: UrlStorage;
}

function fingerprintPrefix(accountId: string): string {
  return `nu-upload:${accountId}:`;
}

/** One stored upload per account, target and file: choosing the same file again finds it. */
function fingerprintOf(accountId: string, target: UploadTarget, file: File): string {
  const parts = [target.resourceId ?? "home", target.folder, file.name, file.size, file.lastModified];
  return fingerprintPrefix(accountId) + parts.map((part) => encodeURIComponent(String(part))).join(":");
}

/** A tus failure's problem answer, if it had one. */
function apiErrorOf(error: Error | DetailedError): ApiError | undefined {
  const response = "originalResponse" in error ? error.originalResponse : null;
  if (response === null) return undefined;
  const status = response.getStatus();
  let body: unknown;
  try {
    body = JSON.parse(response.getBody()) as unknown;
  } catch {
    body = undefined;
  }
  const parsed = problemSchema.safeParse(body);
  return new ApiError(parsed.success ? parsed.data : { type: "about:blank", title: "Upload failed", status });
}

/** Retry only what a later attempt can fix: no answer, a lock, or a server error other than a full disk. */
function shouldRetry(error: DetailedError): boolean {
  const status = error.originalResponse?.getStatus() ?? 0;
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  return status === 0 || status === 423 || (status >= 500 && status !== 507);
}

let nextId = 0;

/** A store of uploads over tus, independent of React: the file browser subscribes to it. */
export function createUploadStore({ accountId, urlStorage = defaultUrlStorage() }: UploadStoreOptions): UploadStore {
  const entries = new Map<string, Entry>();
  let snapshot: readonly UploadRecord[] = [];
  const listeners = new Set<() => void>();
  const doneListeners = new Set<(event: UploadDoneEvent) => void>();

  const publish = () => {
    snapshot = Array.from(entries.values(), (entry) => entry.record);
    for (const listener of listeners) listener();
  };

  const update = (id: string, change: Partial<UploadRecord>) => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entry.record = { ...entry.record, ...change };
    publish();
  };

  const optionsOf = (entry: Entry): UploadOptions => {
    const { id, name, folder, resourceId } = entry.record;
    return {
      endpoint: UPLOAD_ENDPOINT,
      chunkSize: UPLOAD_CHUNK_BYTES,
      metadata: { folder, name, onConflict: entry.onConflict, ...(resourceId === undefined ? {} : { resourceId }) },
      headers: { [REQUEST_MARKER_HEADER]: "1" },
      fingerprint: (file) => Promise.resolve(fingerprintOf(accountId, { folder, resourceId }, file)),
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      retryDelays: [0, 1000, 3000, 5000],
      onShouldRetry: (error) => shouldRetry(error),
      urlStorage,
      onProgress: (bytesSent, bytesTotal) => {
        if (entries.get(id)?.record.state === "uploading") update(id, { bytesSent, bytesTotal });
      },
      onSuccess: () => {
        const current = entries.get(id);
        if (current === undefined) return;
        update(id, { state: "done", bytesSent: current.record.bytesTotal, error: undefined });
        const done = entries.get(id)?.record;
        if (done !== undefined) for (const listener of doneListeners) listener({ type: "done", upload: done });
        pump();
      },
      onError: (error) => {
        fail(id, error);
        pump();
      },
    };
  };

  const fail = (id: string, error: Error | DetailedError) => {
    const apiError = apiErrorOf(error);
    if (apiError?.type === problemTypes.nameTaken) {
      update(id, { state: "failed", conflict: true, error: "A file with this name is already in this folder." });
      return;
    }
    if (apiError === undefined || (apiError.status >= 500 && apiError.status !== 507)) {
      // The connection dropped or the server stumbled: what was sent is kept, so it can go on later.
      update(id, { state: "paused", error: "The upload stopped. Resume it to go on." });
      return;
    }
    update(id, { state: "failed", error: problemMessage(apiError, "The upload did not work. Try again.") });
  };

  const begin = (entry: Entry) => {
    const { file } = entry;
    if (file === undefined) return;
    const id = entry.record.id;
    update(id, { state: "uploading", error: undefined });
    if (entry.upload !== undefined) {
      entry.upload.start();
      return;
    }
    const upload = new Upload(file, optionsOf(entry));
    entry.upload = upload;
    const previous = entry.previous;
    if (previous !== undefined) {
      upload.resumeFromPreviousUpload(previous);
      upload.start();
      return;
    }
    void upload
      .findPreviousUploads()
      .catch(() => [])
      .then((found) => {
        // Paused or cancelled while looking.
        if (entries.get(id)?.upload !== upload || entries.get(id)?.record.state !== "uploading") return;
        const [latest] = found;
        if (latest !== undefined) upload.resumeFromPreviousUpload(latest);
        upload.start();
      });
  };

  function pump(): void {
    let active = snapshot.filter((record) => record.state === "uploading").length;
    for (const entry of entries.values()) {
      if (active >= MAX_ACTIVE_UPLOADS) return;
      if (entry.record.state !== "queued" || entry.file === undefined) continue;
      begin(entry);
      active += 1;
    }
  }

  const addEntry = (file: File, target: UploadTarget) => {
    nextId += 1;
    const id = `upload-${nextId}`;
    entries.set(id, {
      file,
      onConflict: "fail",
      record: {
        id,
        name: file.name,
        folder: target.folder,
        ...(target.resourceId === undefined ? {} : { resourceId: target.resourceId }),
        bytesSent: 0,
        bytesTotal: file.size,
        state: "queued",
        conflict: false,
        needsFile: false,
      },
    });
  };

  const store: UploadStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDone: (listener) => {
      doneListeners.add(listener);
      return () => doneListeners.delete(listener);
    },
    add: (files, target) => {
      for (const file of files) {
        const waiting = Array.from(entries.values()).find(
          (entry) => entry.record.needsFile && entry.record.name === file.name && entry.record.bytesTotal === file.size,
        );
        if (waiting === undefined) {
          addEntry(file, target);
          continue;
        }
        waiting.file = file;
        waiting.record = { ...waiting.record, needsFile: false, state: "queued", error: undefined };
      }
      publish();
      pump();
    },
    pause: (id) => {
      const entry = entries.get(id);
      if (entry === undefined || (entry.record.state !== "uploading" && entry.record.state !== "queued")) return;
      update(id, { state: "paused" });
      void entry.upload?.abort().catch(() => undefined);
      pump();
    },
    resume: (id) => {
      const entry = entries.get(id);
      if (entry === undefined || entry.record.needsFile || entry.record.state !== "paused") return;
      update(id, { state: "queued", error: undefined });
      pump();
    },
    cancel: (id) => {
      const entry = entries.get(id);
      if (entry === undefined) return;
      entries.delete(id);
      publish();
      if (entry.upload !== undefined) {
        void entry.upload.abort(true).catch(() => undefined);
      } else if (entry.previous !== undefined) {
        const { uploadUrl, urlStorageKey } = entry.previous;
        if (uploadUrl !== null) void Upload.terminate(uploadUrl, { headers: { [REQUEST_MARKER_HEADER]: "1" } }).catch(() => undefined);
        void urlStorage.removeUpload(urlStorageKey).catch(() => undefined);
      }
      pump();
    },
    resolveConflict: (id, choice) => {
      const entry = entries.get(id);
      if (entry === undefined || !entry.record.conflict) return;
      entry.onConflict = choice;
      delete entry.upload;
      delete entry.previous;
      entry.record = { ...entry.record, conflict: false, state: "queued", error: undefined, bytesSent: 0 };
      publish();
      pump();
    },
    clearFinished: () => {
      for (const [id, entry] of entries) {
        if (entry.record.state === "done" || (entry.record.state === "failed" && !entry.record.conflict)) entries.delete(id);
      }
      publish();
    },
    restore: async () => {
      const stored = await urlStorage.findAllUploads().catch(() => []);
      const prefix = `tus::${fingerprintPrefix(accountId)}`;
      for (const previous of stored) {
        if (!previous.urlStorageKey.startsWith(prefix) || previous.uploadUrl === null) continue;
        const known = Array.from(entries.values()).some((entry) => entry.previous?.urlStorageKey === previous.urlStorageKey);
        const { name, folder = "", resourceId, onConflict } = previous.metadata;
        if (known || name === undefined) continue;
        nextId += 1;
        const id = `upload-${nextId}`;
        entries.set(id, {
          previous,
          onConflict: onConflict === "replace" || onConflict === "keep-both" ? onConflict : "fail",
          record: {
            id,
            name,
            folder,
            ...(resourceId === undefined ? {} : { resourceId }),
            bytesSent: 0,
            bytesTotal: previous.size ?? 0,
            state: "paused",
            conflict: false,
            needsFile: true,
          },
        });
      }
      publish();
    },
  };
  return store;
}

const stores = new Map<string, UploadStore>();

/**
 * The account's upload store, made (and its unfinished uploads restored) on first use. It outlives
 * the page, so uploads go on while the account looks at another screen of the app.
 */
export function uploadStoreFor(accountId: string): UploadStore {
  let store = stores.get(accountId);
  if (store === undefined) {
    store = createUploadStore({ accountId });
    stores.set(accountId, store);
    void store.restore();
  }
  return store;
}
