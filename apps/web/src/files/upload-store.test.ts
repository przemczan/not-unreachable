import { UPLOAD_CHUNK_BYTES, problemMediaType, problemTypes } from "@not-unreachable/contracts";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/** One `new Upload(…)` of the mocked tus-js-client: its file, options and calls. */
interface FakeUpload {
  readonly file: File;
  readonly options: {
    endpoint: string;
    chunkSize: number;
    metadata: { folder?: string; name?: string; onConflict?: string; resourceId?: string };
    headers: Record<string, string>;
    onProgress: (sent: number, total: number) => void;
    onSuccess: () => void;
    onError: (error: Error) => void;
    fingerprint: (file: File) => Promise<string>;
  };
  readonly start: Mock<() => void>;
  readonly abort: Mock<(terminate?: boolean) => Promise<void>>;
  readonly findPreviousUploads: Mock<() => Promise<unknown[]>>;
  readonly resumeFromPreviousUpload: Mock<(previous: unknown) => void>;
}

const tus = vi.hoisted(() => ({
  instances: [] as FakeUpload[],
  previous: [] as unknown[],
  terminate: vi.fn<(url: string, options: unknown) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("tus-js-client", () => {
  class Upload {
    static terminate = tus.terminate;
    readonly start = vi.fn<() => void>();
    readonly abort = vi.fn<(terminate?: boolean) => Promise<void>>(() => Promise.resolve());
    readonly findPreviousUploads = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve(tus.previous));
    readonly resumeFromPreviousUpload = vi.fn<(previous: unknown) => void>();
    readonly file: File;
    readonly options: FakeUpload["options"];
    constructor(file: File, options: FakeUpload["options"]) {
      this.file = file;
      this.options = options;
      tus.instances.push(this);
    }
  }
  // As in a browser without a usable localStorage: tus's own fallback storage lacks findAllUploads.
  return { Upload, defaultOptions: { urlStorage: { listAllUploads: () => Promise.resolve([]) } } };
});

const { createUploadStore, MAX_ACTIVE_UPLOADS, UPLOAD_ENDPOINT } = await import("./upload-store.ts");

/** An in-memory stand-in for tus's localStorage URL storage. */
function memoryStorage(entries: Record<string, unknown>[] = []) {
  return {
    findAllUploads: vi.fn<() => Promise<Record<string, unknown>[]>>(() => Promise.resolve(entries)),
    findUploadsByFingerprint: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
    removeUpload: vi.fn<(key: string) => Promise<void>>(() => Promise.resolve()),
    addUpload: vi.fn<() => Promise<string>>(() => Promise.resolve("key")),
  };
}

type Storage = ReturnType<typeof memoryStorage>;

function storeWith(storage: Storage = memoryStorage()) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake implements what the store calls.
  return createUploadStore({ accountId: "acc-1", urlStorage: storage as never });
}

function upload(index: number): FakeUpload {
  const instance = tus.instances[index];
  if (instance === undefined) throw new Error(`No upload ${index}`);
  return instance;
}

/** A tus failure with a problem answer, as tus-js-client's DetailedError carries it. */
function problemError(status: number, type: string, extensions: Record<string, string> = {}): Error {
  return Object.assign(new Error("tus: unexpected response"), {
    originalRequest: {},
    originalResponse: {
      getStatus: () => status,
      getHeader: (name: string) => (name.toLowerCase() === "content-type" ? problemMediaType : undefined),
      getBody: () => JSON.stringify({ type, title: "Problem", status, ...extensions }),
    },
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const report = new File(["x".repeat(10)], "report.pdf", { type: "application/pdf", lastModified: 1 });

beforeEach(() => {
  tus.instances.length = 0;
  tus.previous = [];
  tus.terminate.mockClear();
});

describe("upload store", () => {
  it("starts a tus upload in 16 MiB chunks with the target as metadata and the CSRF header", async () => {
    const store = storeWith();
    store.add([report], { folder: "Photos/2026" });
    await flush();

    const { options, start } = upload(0);
    expect(options.endpoint).toBe(UPLOAD_ENDPOINT);
    expect(options.chunkSize).toBe(UPLOAD_CHUNK_BYTES);
    expect(options.metadata).toEqual({ folder: "Photos/2026", name: "report.pdf", onConflict: "fail" });
    expect(options.headers).toEqual({ "X-NU-Request": "1" });
    expect(start).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject([{ name: "report.pdf", state: "uploading", bytesTotal: 10 }]);
  });

  it("sends the resource id for the admin and keys resumable uploads by account and target", async () => {
    const store = storeWith();
    store.add([report], { folder: "", resourceId: "5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d01" });
    await flush();
    const { options } = upload(0);
    expect(options.metadata.resourceId).toBe("5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d01");
    expect(await options.fingerprint(report)).toBe("nu-upload:acc-1:5d0c5f8e-2b8a-4c47-9d1e-6a8f0b1c2d01::report.pdf:10:1");
  });

  it("resumes an upload this browser left unfinished for the same file", async () => {
    const previous = { uploadUrl: "/api/v1/uploads/abc", urlStorageKey: "tus::k", metadata: {}, size: 10, creationTime: "" };
    tus.previous = [previous];
    const store = storeWith();
    store.add([report], { folder: "" });
    await flush();
    expect(upload(0).resumeFromPreviousUpload).toHaveBeenCalledWith(previous);
    expect(upload(0).start).toHaveBeenCalledOnce();
  });

  it("tracks progress, then marks it done and tells the listeners", async () => {
    const store = storeWith();
    const done = vi.fn<(event: unknown) => void>();
    store.onDone(done);
    store.add([report], { folder: "" });
    await flush();

    upload(0).options.onProgress(4, 10);
    expect(store.getSnapshot()[0]).toMatchObject({ bytesSent: 4, state: "uploading" });
    upload(0).options.onSuccess();
    expect(store.getSnapshot()[0]).toMatchObject({ bytesSent: 10, state: "done" });
    expect(done).toHaveBeenCalledWith({ type: "done", upload: expect.objectContaining({ name: "report.pdf" }) });

    store.clearFinished();
    expect(store.getSnapshot()).toEqual([]);
  });

  it("pauses by aborting, resumes by starting again, and cancels by terminating", async () => {
    const store = storeWith();
    store.add([report], { folder: "" });
    await flush();
    const id = store.getSnapshot()[0]?.id ?? "";

    store.pause(id);
    expect(upload(0).abort).toHaveBeenCalledWith();
    expect(store.getSnapshot()[0]?.state).toBe("paused");

    store.resume(id);
    expect(upload(0).start).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()[0]?.state).toBe("uploading");

    store.cancel(id);
    expect(upload(0).abort).toHaveBeenLastCalledWith(true);
    expect(store.getSnapshot()).toEqual([]);
  });

  it(`sends at most ${MAX_ACTIVE_UPLOADS} at once and starts the next when one ends`, async () => {
    const store = storeWith();
    const files = ["a", "b", "c", "d"].map((name) => new File(["1"], `${name}.txt`));
    store.add(files, { folder: "" });
    await flush();
    expect(tus.instances).toHaveLength(MAX_ACTIVE_UPLOADS);
    expect(store.getSnapshot().map((record) => record.state)).toEqual(["uploading", "uploading", "uploading", "queued"]);

    upload(0).options.onSuccess();
    await flush();
    expect(tus.instances).toHaveLength(4);
    expect(store.getSnapshot()[3]?.state).toBe("uploading");
  });

  it("asks Replace or Keep both when the name is taken, then starts again with the choice", async () => {
    const store = storeWith();
    store.add([report], { folder: "" });
    await flush();
    upload(0).options.onError(problemError(409, problemTypes.nameTaken));
    const [record] = store.getSnapshot();
    expect(record).toMatchObject({ state: "failed", conflict: true });

    store.resolveConflict(record?.id ?? "", "keep-both");
    await flush();
    expect(upload(1).options.metadata.onConflict).toBe("keep-both");
    expect(store.getSnapshot()[0]).toMatchObject({ state: "uploading", conflict: false });
  });

  it("puts refusals in words and keeps a dropped connection resumable", async () => {
    const store = storeWith();
    store.add([report, new File(["1"], "b.txt")], { folder: "" });
    await flush();

    upload(0).options.onError(problemError(413, problemTypes.quotaExceeded));
    expect(store.getSnapshot()[0]).toMatchObject({
      state: "failed",
      error: "There isn't enough room left in your storage for this file. Delete some files and try again.",
    });

    upload(1).options.onError(new Error("network"));
    expect(store.getSnapshot()[1]).toMatchObject({ state: "paused", error: "The upload stopped. Resume it to go on." });
  });

  it("says which upload limit was met", async () => {
    const store = storeWith();
    store.add([report], { folder: "" });
    await flush();
    upload(0).options.onError(problemError(429, problemTypes.tooManyUploads, { reason: "in-progress-per-account" }));
    expect(store.getSnapshot()[0]?.error).toBe("You have too many uploads in progress. Let one finish, or cancel one, then try again.");
  });

  it("restores this account's unfinished uploads after a reload, and resumes one when its file is chosen again", async () => {
    const mine = {
      urlStorageKey: "tus::nu-upload:acc-1:home:Photos:report.pdf:10:1::42",
      uploadUrl: "/api/v1/uploads/abc",
      metadata: { folder: "Photos", name: "report.pdf", onConflict: "fail" },
      size: 10,
      creationTime: "",
    };
    const theirs = { ...mine, urlStorageKey: "tus::nu-upload:acc-2:home:x::1", metadata: { folder: "", name: "other.txt" } };
    const store = storeWith(memoryStorage([mine, theirs]));
    await store.restore();

    expect(store.getSnapshot()).toMatchObject([{ name: "report.pdf", folder: "Photos", state: "paused", needsFile: true, bytesTotal: 10 }]);
    const id = store.getSnapshot()[0]?.id ?? "";
    store.resume(id);
    expect(tus.instances).toHaveLength(0);

    // Chosen again while looking at another folder: it still goes to its own.
    store.add([report], { folder: "" });
    await flush();
    expect(store.getSnapshot()).toHaveLength(1);
    expect(upload(0).options.metadata.folder).toBe("Photos");
    expect(upload(0).resumeFromPreviousUpload).toHaveBeenCalledWith(mine);
    expect(store.getSnapshot()[0]).toMatchObject({ state: "uploading", needsFile: false });
  });

  it("cancels a restored upload without its file by terminating it on the server", async () => {
    const storage = memoryStorage([
      {
        urlStorageKey: "tus::nu-upload:acc-1:home::report.pdf:10:1::42",
        uploadUrl: "/api/v1/uploads/abc",
        metadata: { folder: "", name: "report.pdf" },
        size: 10,
        creationTime: "",
      },
    ]);
    const store = storeWith(storage);
    await store.restore();
    store.cancel(store.getSnapshot()[0]?.id ?? "");
    expect(tus.terminate).toHaveBeenCalledWith("/api/v1/uploads/abc", { headers: { "X-NU-Request": "1" } });
    expect(storage.removeUpload).toHaveBeenCalledWith("tus::nu-upload:acc-1:home::report.pdf:10:1::42");
    expect(store.getSnapshot()).toEqual([]);
  });

  it("restores nothing, without failing, where the browser can't store upload URLs", async () => {
    const store = createUploadStore({ accountId: "acc-1" });
    await expect(store.restore()).resolves.toBeUndefined();
    expect(store.getSnapshot()).toEqual([]);
  });
});
