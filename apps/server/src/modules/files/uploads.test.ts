import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  problemTypes,
  quotaSchema,
  routes,
  TUS_VERSION,
  UPLOAD_PATCH_MAX_BYTES,
  uploadLimitsSchema,
  type UploadLimits,
} from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFilesTestApp,
  callFilesRoute,
  corsHeaders,
  expectProblem,
  locationOf,
  tusClient,
  uploadIdOf,
  type FilesTestApp,
  type TusTestClient,
} from "../../test-support/index.ts";
import { tableRows } from "../../test-support/sessions.ts";

let files: FilesTestApp;
let alice: TusTestClient;
let admin: TusTestClient;

beforeEach(async () => {
  files = await buildFilesTestApp();
  alice = tusClient(files.test, files.userCookie);
  admin = tusClient(files.test, files.adminCookie);
});
afterEach(async () => {
  await files.close();
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIB = 1024 ** 3;

const staged = (): string[] => (existsSync(files.stagingDir) ? readdirSync(files.stagingDir) : []);
const uploadRows = () => tableRows(files.test, "uploads");
const homeFiles = (folder = ""): string[] => readdirSync(join(files.homeDir, folder)).toSorted();
const setLimits = (change: Partial<UploadLimits>): void => {
  files.test.settings.set("uploadLimits", { ...files.test.settings.get("uploadLimits"), ...change }, null);
};
/** A HEAD answer has no body: only its status and the tus header tell. */
const expectHeadRefused = (response: LightMyRequestResponse, status: number) => {
  expect(response.statusCode).toBe(status);
  expect(response.headers["tus-resumable"]).toBe(TUS_VERSION);
  expect(response.body).toBe("");
};
const expectTusProblem = (response: LightMyRequestResponse, status: number, type: string) => {
  const problem = expectProblem(response, status, type);
  expect(response.headers["tus-resumable"]).toBe(TUS_VERSION);
  return problem;
};

describe("a tus upload", () => {
  it("is created with a UUIDv7 Location, staged 0600, and nothing in the target yet", async () => {
    const created = await alice.create(11, { folder: "", name: "hello.txt", onConflict: "fail" });
    expect(created.statusCode).toBe(201);
    const location = locationOf(created);
    expect(location).toMatch(/^\/api\/v1\/uploads\/[0-9a-f-]{36}$/);
    const id = uploadIdOf(location);
    expect(id).toMatch(UUID_V7);
    expect(created.headers["tus-resumable"]).toBe(TUS_VERSION);
    expect(corsHeaders(created)).toEqual([]);
    expect(created.headers["cache-control"]).toBe("no-store");

    expect(uploadRows()).toEqual([
      expect.objectContaining({
        id,
        account_id: files.user.id,
        target_resource_id: null,
        target_path: "",
        file_name: "hello.txt",
        size: 11,
        offset: 0,
      }),
    ]);
    expect(staged()).toEqual([id]);
    expect(statSync(join(files.stagingDir, id)).mode & 0o777).toBe(0o600);
    expect(statSync(files.stagingDir).mode & 0o777).toBe(0o700);
    expect(homeFiles()).toEqual([]);
  });

  it("takes chunks, resumes from HEAD's offset, and moves the file into place at the last one", async () => {
    const location = locationOf(await alice.create(11, { folder: "", name: "hello.txt", onConflict: "fail" }));
    const first = await alice.patch(location, 0, Buffer.from("hello"));
    expect(first.statusCode).toBe(204);
    expect(first.headers["upload-offset"]).toBe("5");
    expect(first.headers["tus-resumable"]).toBe(TUS_VERSION);
    expect(corsHeaders(first)).toEqual([]);

    // The client lost its place: it asks, then goes on from there.
    const head = await alice.head(location);
    expect(head.statusCode).toBe(200);
    expect(head.headers).toMatchObject({ "upload-offset": "5", "upload-length": "11", "tus-resumable": TUS_VERSION });
    expect(corsHeaders(head)).toEqual([]);
    expectTusProblem(await alice.patch(location, 0, Buffer.from("hello")), 409, problemTypes.badRequest);

    const last = await alice.patch(location, 5, Buffer.from(" world"));
    expect(last.statusCode).toBe(204);
    expect(last.headers["upload-offset"]).toBe("11");
    expect(readFileSync(join(files.homeDir, "hello.txt"), "utf8")).toBe("hello world");
    expect(homeFiles()).toEqual(["hello.txt"]);
    expect(staged()).toEqual([]);
    expect(uploadRows()).toEqual([]);
    expect(files.test.audited("file.uploaded")[0]).toMatchObject({
      actorKind: "account",
      actorAccountId: files.user.id,
      outcome: "succeeded",
      details: { resourceId: null, path: "hello.txt", size: 11, onConflict: "fail" },
    });
    expectHeadRefused(await alice.head(location), 404);
  });

  it("records each chunk's offset and moves the expiry on", async () => {
    const location = locationOf(await alice.create(10, { folder: "", name: "a.bin", onConflict: "fail" }));
    files.test.clock.advance(60_000);
    await alice.patch(location, 0, Buffer.from("12345"));
    const [row] = uploadRows();
    expect(row).toMatchObject({ offset: 5, last_chunk_at: files.test.clock.now().toISOString() });
    expect(row?.["expires_at"]).toBe(new Date(files.test.clock.now().getTime() + 24 * 3600_000).toISOString());
  });

  it("goes into a subfolder, and a zero-byte file lands at creation", async () => {
    mkdirSync(join(files.homeDir, "docs"));
    expect((await alice.upload(Buffer.from("x"), { folder: "docs", name: "x.txt", onConflict: "fail" })).statusCode).toBe(204);
    expect(readFileSync(join(files.homeDir, "docs", "x.txt"), "utf8")).toBe("x");
    const empty = await alice.create(0, { folder: "docs", name: "empty.txt", onConflict: "fail" });
    expect(empty.statusCode).toBe(201);
    expect(readFileSync(join(files.homeDir, "docs", "empty.txt"), "utf8")).toBe("");
    expect(uploadRows()).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it("is cancelled with DELETE, which deletes what was staged", async () => {
    const location = locationOf(await alice.create(10, { folder: "", name: "a.bin", onConflict: "fail" }));
    await alice.patch(location, 0, Buffer.from("12345"));
    const cancelled = await alice.cancel(location);
    expect(cancelled.statusCode).toBe(204);
    expect(cancelled.headers["tus-resumable"]).toBe(TUS_VERSION);
    expect(staged()).toEqual([]);
    expect(uploadRows()).toEqual([]);
    expectHeadRefused(await alice.head(location), 404);
    expect(homeFiles()).toEqual([]);
  });

  it("answers 404 to any other account, whatever it asks", async () => {
    const location = locationOf(await alice.create(10, { folder: "", name: "a.bin", onConflict: "fail" }));
    const bob = tusClient(files.test, (await files.addUser("bob")).cookie);
    for (const client of [bob, admin]) {
      expectHeadRefused(await client.head(location), 404);
      expectTusProblem(await client.patch(location, 0, Buffer.from("12345")), 404, problemTypes.notFound);
      expectTusProblem(await client.cancel(location), 404, problemTypes.notFound);
    }
    expect(uploadRows()).toMatchObject([{ offset: 0 }]);
    expect(statSync(join(files.stagingDir, uploadIdOf(location))).size).toBe(0);
    expectHeadRefused(await alice.head("/api/v1/uploads/01900000-0000-7000-8000-000000000000"), 404);
  });

  it("needs a session, the CSRF header and the tus media type", async () => {
    const location = locationOf(await alice.create(10, { folder: "", name: "a.bin", onConflict: "fail" }));
    const anonymous = tusClient(files.test, "");
    expectProblem(await anonymous.create(10, { name: "b.bin" }), 401, problemTypes.signInRequired);
    expectProblem(await alice.patch(location, 0, Buffer.from("12345"), { "x-nu-request": "" }), 403, problemTypes.csrfRejected);
    expectProblem(
      await alice.patch(location, 0, Buffer.from("12345"), { "content-type": "text/plain" }),
      415,
      problemTypes.unsupportedMediaType,
    );
    expect(uploadRows()).toMatchObject([{ offset: 0 }]);
  });

  it("refuses a PATCH declared over 64 MiB", async () => {
    const location = locationOf(await alice.create(UPLOAD_PATCH_MAX_BYTES + 1024, { folder: "", name: "big.bin", onConflict: "fail" }));
    const declared = await alice.patch(location, 0, Buffer.alloc(16), { "content-length": String(UPLOAD_PATCH_MAX_BYTES + 1) });
    expectTusProblem(declared, 413, problemTypes.payloadTooLarge);
  });

  it("refuses a streamed PATCH once it passes 64 MiB", async () => {
    const location = locationOf(await alice.create(UPLOAD_PATCH_MAX_BYTES + 1024, { folder: "", name: "big.bin", onConflict: "fail" }));
    const megabyte = Buffer.alloc(1024 * 1024, 7);
    const streamed = Readable.from(
      (function* () {
        for (let index = 0; index < 64; index += 1) yield megabyte;
        yield Buffer.alloc(1, 7);
      })(),
    );
    expectTusProblem(await alice.patch(location, 0, streamed), 413, problemTypes.payloadTooLarge);
    const head = await alice.head(location);
    expect(Number(head.headers["upload-offset"])).toBeLessThanOrEqual(UPLOAD_PATCH_MAX_BYTES);
  });
});

const expectNothingStored = () => {
  expect(uploadRows()).toEqual([]);
  expect(staged()).toEqual([]);
};

describe("the checks at creation, before any byte is stored", () => {
  it("needs Upload-Length, and never takes a deferred one", async () => {
    expectTusProblem(await alice.create(null, { name: "a.bin" }), 400, problemTypes.uploadLengthRequired);
    expectTusProblem(await alice.create(null, { name: "a.bin" }, { "upload-defer-length": "1" }), 400, problemTypes.uploadLengthRequired);
    expectTusProblem(await alice.create(10, { name: "a.bin" }, { "upload-defer-length": "1" }), 400, problemTypes.uploadLengthRequired);
    expectNothingStored();
  });

  it("refuses a resource id in a user's metadata, and needs one from the admin", async () => {
    const withResource = await alice.create(10, { name: "a.bin", resourceId: files.resourceId });
    expectTusProblem(withResource, 400, problemTypes.validationFailed);
    expectTusProblem(await alice.create(10, { name: "a.bin", extra: "x" }), 400, problemTypes.validationFailed);
    expectTusProblem(await admin.create(10, { name: "a.bin" }), 400, problemTypes.validationFailed);
    expectNothingStored();
    expect(existsSync(join(files.resourceDir, "a.bin"))).toBe(false);
  });

  it("checks the target folder and the name by T5", async () => {
    writeFileSync(join(files.homeDir, "file.txt"), "x");
    expect(expectTusProblem(await alice.create(10, { folder: "../bob", name: "a.bin" }), 422, problemTypes.pathRefused).reason).toBe(
      "invalid",
    );
    expect(expectTusProblem(await alice.create(10, { folder: "/etc", name: "a.bin" }), 422, problemTypes.pathRefused).reason).toBe(
      "invalid",
    );
    expectTusProblem(await alice.create(10, { folder: "missing", name: "a.bin" }), 404, problemTypes.notFound);
    expect(expectTusProblem(await alice.create(10, { folder: "file.txt", name: "a.bin" }), 422, problemTypes.pathRefused).reason).toBe(
      "not-a-folder",
    );
    for (const [name, reason] of [
      ["CON", "reserved-name"],
      ["a:b", "reserved-character"],
      ["trailing.", "trailing-dot-or-space"],
      ["..", "dot"],
    ] as const) {
      expect(expectTusProblem(await alice.create(10, { name }), 422, problemTypes.pathRefused).reason).toBe(reason);
    }
    expectNothingStored();
  });

  it.each<[string, Record<string, string>, string]>([
    ["a NUL byte in the name", { name: "a.txt\0.png" }, "control-character"],
    ["a control character in the name", { name: "a\u001b[31m.txt" }, "control-character"],
    ["DEL in the name", { name: "a\u007f.txt" }, "control-character"],
    ["a 256-byte name", { name: "é".repeat(128) }, "too-long"],
    ["COM1 with an extension", { name: "com1.txt" }, "reserved-name"],
    ["LPT9", { name: "LPT9" }, "reserved-name"],
    ["NUL with a space before its extension", { name: "nul .tar.gz" }, "reserved-name"],
    ["a reserved character", { name: "what?.txt" }, "reserved-character"],
    ["a backslash", { name: "..\\..\\evil.txt" }, "reserved-character"],
    ["a trailing space", { name: "a.txt " }, "trailing-dot-or-space"],
    ["a NUL byte in the folder", { folder: "docs\0", name: "a.txt" }, "invalid"],
    ["a control character in the folder", { folder: "docs\n", name: "a.txt" }, "invalid"],
    ["a backslash in the folder", { folder: "..\\bob", name: "a.txt" }, "invalid"],
    ["a folder segment over 255 bytes", { folder: "a".repeat(256), name: "a.txt" }, "too-long"],
  ])("refuses %s before storing anything", async (_case, metadata, reason) => {
    mkdirSync(join(files.homeDir, "docs"));
    const problem = expectTusProblem(await alice.create(10, metadata), 422, problemTypes.pathRefused);
    expect(problem.reason).toBe(reason);
    expectNothingStored();
    expect(homeFiles()).toEqual(["docs"]);
  });

  it("refuses metadata that breaks its schema: an unknown onConflict, a name or folder over the limits", async () => {
    expectTusProblem(await alice.create(10, { name: "a.txt", onConflict: "overwrite" }), 400, problemTypes.validationFailed);
    expectTusProblem(await alice.create(10, { name: "a".repeat(256) }), 400, problemTypes.validationFailed);
    expectTusProblem(await alice.create(10, { folder: "a/".repeat(2049), name: "a.txt" }), 400, problemTypes.validationFailed);
    expectTusProblem(await alice.create(10, { name: "" }), 400, problemTypes.validationFailed);
    expectTusProblem(await admin.create(10, { name: "a.txt", resourceId: "not-a-uuid" }), 400, problemTypes.validationFailed);
    expectNothingStored();
  });

  it("checks the admin's target resource and keeps the folder inside it", async () => {
    const unknown = "01900000-0000-7000-8000-000000000000";
    expectTusProblem(await admin.create(10, { name: "a.txt", resourceId: unknown }), 404, problemTypes.notFound);
    for (const folder of ["..", "../homes/alice", "/etc"]) {
      const refused = await admin.create(10, { folder, name: "a.txt", resourceId: files.resourceId });
      expect(expectTusProblem(refused, 422, problemTypes.pathRefused).reason).toBe("invalid");
    }
    symlinkSync(join(files.homeDir, ".."), join(files.resourceDir, "homes-link"));
    const throughLink = await admin.create(10, { folder: "homes-link/alice", name: "a.txt", resourceId: files.resourceId });
    expect(expectTusProblem(throughLink, 422, problemTypes.pathRefused).reason).toBe("symlink");
    expectNothingStored();
    expect(homeFiles()).toEqual([]);
  });

  it("refuses a file over the size limit", async () => {
    setLimits({ maxFileBytes: 10 });
    expectTusProblem(await alice.create(11, { name: "a.bin" }), 413, problemTypes.fileTooLarge);
    expectTusProblem(await admin.create(11, { name: "a.bin", resourceId: files.resourceId }), 413, problemTypes.fileTooLarge);
    expect((await alice.create(10, { name: "a.bin" })).statusCode).toBe(201);
  });

  it("refuses an upload over the quota with 413, counting the home and unfinished uploads", async () => {
    files.test.services.accounts.setQuota(files.user.id, 100);
    writeFileSync(join(files.homeDir, "old.bin"), Buffer.alloc(60));
    expectTusProblem(await alice.create(41, { name: "a.bin" }), 413, problemTypes.quotaExceeded);
    expectNothingStored();
    expect((await alice.create(25, { name: "a.bin" })).statusCode).toBe(201);
    expectTusProblem(await alice.create(16, { name: "b.bin" }), 413, problemTypes.quotaExceeded);

    const quota = await callFilesRoute(files.test, routes.getHomeQuota, { cookie: files.userCookie });
    expect(quotaSchema.parse(quota.json())).toEqual({ usedBytes: 85, limitBytes: 100 });
    // The admin has no quota.
    expect((await admin.create(10 * GIB, { name: "big.iso", resourceId: files.resourceId })).statusCode).toBe(201);
  });

  it("lets only as many uploads created at once in as fit the quota", async () => {
    files.test.services.accounts.setQuota(files.user.id, 100);
    // Both creations pass their first quota check before either is recorded.
    files.space.hold = new Promise((resolve) => setTimeout(resolve, 50));
    const created = await Promise.all([alice.create(60, { name: "a.bin" }), alice.create(60, { name: "b.bin" })]);
    expect(created.map((response) => response.statusCode).toSorted((a, b) => a - b)).toEqual([201, 413]);
    expect(uploadRows()).toHaveLength(1);
  });

  it("falls back to the default quota", async () => {
    files.test.settings.set("defaultQuotaBytes", 50, null);
    const quota = await callFilesRoute(files.test, routes.getHomeQuota, { cookie: files.userCookie });
    expect(quotaSchema.parse(quota.json())).toEqual({ usedBytes: 0, limitBytes: 50 });
    expectTusProblem(await alice.create(51, { name: "a.bin" }), 413, problemTypes.quotaExceeded);
    expectProblem(await callFilesRoute(files.test, routes.getHomeQuota, { cookie: files.adminCookie }), 403, problemTypes.forbidden);
  });

  it("keeps the disk reserve on the staging disk and the target, for the admin too", async () => {
    // 5 % of 100 GiB is 5 GiB, the same as the default floor: 2 GiB more would leave 4 GiB.
    files.space.staging = { availableBytes: 6 * GIB, totalBytes: 100 * GIB };
    expectTusProblem(await alice.create(2 * GIB, { name: "a.bin" }), 507, problemTypes.insufficientStorage);
    expectTusProblem(await admin.create(2 * GIB, { name: "a.bin", resourceId: files.resourceId }), 507, problemTypes.insufficientStorage);
    expect((await admin.create(GIB / 2, { name: "a.bin", resourceId: files.resourceId })).statusCode).toBe(201);

    files.space.staging = { availableBytes: 1000 * GIB, totalBytes: 1000 * GIB };
    // 10 % of 1000 GiB is the floor that counts here.
    files.space.target = { availableBytes: 101 * GIB, totalBytes: 1000 * GIB };
    setLimits({ diskReserve: { percent: 10, bytes: 0 } });
    expectTusProblem(await admin.create(2 * GIB, { name: "b.bin", resourceId: files.resourceId }), 507, problemTypes.insufficientStorage);
    expect((await admin.create(GIB / 2, { name: "b.bin", resourceId: files.resourceId })).statusCode).toBe(201);
  });

  it("allows 4 uploads in progress per account", async () => {
    for (let index = 0; index < 4; index += 1) expect((await alice.create(1, { name: `${index}.bin` })).statusCode).toBe(201);
    expect(expectTusProblem(await alice.create(1, { name: "5.bin" }), 429, problemTypes.tooManyUploads).reason).toBe(
      "in-progress-per-account",
    );
    // Another account still may.
    expect((await admin.create(1, { name: "a.bin", resourceId: files.resourceId })).statusCode).toBe(201);
  });

  it("allows so many uploads in progress on the instance", async () => {
    setLimits({ inProgressPerInstance: 3 });
    for (let index = 0; index < 2; index += 1) expect((await alice.create(1, { name: `${index}.bin` })).statusCode).toBe(201);
    expect((await admin.create(1, { name: "a.bin", resourceId: files.resourceId })).statusCode).toBe(201);
    expect(
      expectTusProblem(await admin.create(1, { name: "b.bin", resourceId: files.resourceId }), 429, problemTypes.tooManyUploads).reason,
    ).toBe("in-progress-per-instance");
  });

  it("allows 20 new uploads per account in an hour, a sliding window", async () => {
    for (let index = 0; index < 20; index += 1) {
      const created = await alice.create(1, { name: `${index}.bin` });
      expect(created.statusCode).toBe(201);
      expect((await alice.cancel(locationOf(created))).statusCode).toBe(204);
      files.test.clock.advance(60_000);
    }
    const refused = await alice.create(1, { name: "21.bin" });
    expect(expectTusProblem(refused, 429, problemTypes.tooManyUploads).reason).toBe("created-per-hour");
    expect(Number(refused.headers["retry-after"])).toBe(40 * 60);
    files.test.clock.advance(40 * 60_000 + 1);
    alice = tusClient(files.test, files.test.startSession(files.user));
    expect((await alice.create(1, { name: "21.bin" })).statusCode).toBe(201);
  });
});

describe("name conflicts", () => {
  beforeEach(() => {
    writeFileSync(join(files.homeDir, "a.txt"), "old");
  });

  it("refuses a taken name by default", async () => {
    expectTusProblem(await alice.create(3, { name: "a.txt" }), 409, problemTypes.nameTaken);
    expectTusProblem(await alice.create(3, { name: "a.txt", onConflict: "fail" }), 409, problemTypes.nameTaken);
    expect(uploadRows()).toEqual([]);
  });

  it("replaces the file with replace", async () => {
    expect((await alice.upload(Buffer.from("new"), { name: "a.txt", onConflict: "replace" })).statusCode).toBe(204);
    expect(readFileSync(join(files.homeDir, "a.txt"), "utf8")).toBe("new");
    expect(homeFiles()).toEqual(["a.txt"]);
  });

  it("never replaces a folder", async () => {
    mkdirSync(join(files.homeDir, "docs"));
    expectTusProblem(await alice.create(3, { name: "docs", onConflict: "replace" }), 409, problemTypes.nameTaken);
  });

  it("keeps both with keep-both", async () => {
    expect((await alice.upload(Buffer.from("new"), { name: "a.txt", onConflict: "keep-both" })).statusCode).toBe(204);
    expect(homeFiles()).toEqual(["a (1).txt", "a.txt"]);
    expect(readFileSync(join(files.homeDir, "a (1).txt"), "utf8")).toBe("new");
    expect(files.test.audited("file.uploaded")[0]?.details).toMatchObject({ path: "a (1).txt", onConflict: "keep-both" });
  });

  it("checks again at the last chunk: a name taken meanwhile drops the upload with 409", async () => {
    const location = locationOf(await alice.create(3, { name: "b.txt" }));
    writeFileSync(join(files.homeDir, "b.txt"), "theirs");
    expectTusProblem(await alice.patch(location, 0, Buffer.from("new")), 409, problemTypes.nameTaken);
    expect(readFileSync(join(files.homeDir, "b.txt"), "utf8")).toBe("theirs");
    expect(uploadRows()).toEqual([]);
    expect(staged()).toEqual([]);
    expect(homeFiles()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("the quota at the last chunk", () => {
  it("is checked again, dropping an upload that no longer fits", async () => {
    files.test.services.accounts.setQuota(files.user.id, 100);
    const location = locationOf(await alice.create(60, { name: "a.bin" }));
    writeFileSync(join(files.homeDir, "meanwhile.bin"), Buffer.alloc(50));
    expectTusProblem(await alice.patch(location, 0, Buffer.alloc(60)), 413, problemTypes.quotaExceeded);
    expect(homeFiles()).toEqual(["meanwhile.bin"]);
    expect(uploadRows()).toEqual([]);
    expect(staged()).toEqual([]);
  });
});

describe("the admin's uploads", () => {
  it("go into a resource, named in the audit", async () => {
    mkdirSync(join(files.resourceDir, "shared"));
    const response = await admin.upload(Buffer.from("report"), {
      folder: "shared",
      name: "r.pdf",
      onConflict: "fail",
      resourceId: files.resourceId,
    });
    expect(response.statusCode).toBe(204);
    expect(readFileSync(join(files.resourceDir, "shared", "r.pdf"), "utf8")).toBe("report");
    expect(files.test.audited("file.uploaded")[0]).toMatchObject({
      targetKind: "resource",
      targetId: files.resourceId,
      details: { resourceId: files.resourceId, path: "shared/r.pdf", size: 6 },
    });
    expectTusProblem(await admin.create(1, { name: "a", resourceId: "01900000-0000-7000-8000-000000000000" }), 404, problemTypes.notFound);
  });
});

describe("the limits settings", () => {
  const limits: UploadLimits = {
    maxFileBytes: 1024,
    diskReserve: { percent: 1, bytes: 2048 },
    inProgressPerAccount: 2,
    inProgressPerInstance: 10,
    createdPerAccountPerHour: 5,
  };

  it("are read and changed by the admin, audited only when they change", async () => {
    const read = await callFilesRoute(files.test, routes.getUploadLimits, { cookie: files.adminCookie });
    expect(uploadLimitsSchema.parse(read.json())).toEqual({
      maxFileBytes: 50 * GIB,
      diskReserve: { percent: 5, bytes: 5 * GIB },
      inProgressPerAccount: 4,
      inProgressPerInstance: 100,
      createdPerAccountPerHour: 20,
    });
    const changed = await callFilesRoute(files.test, routes.updateUploadLimits, { cookie: files.adminCookie, payload: limits });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual(limits);
    expect(files.test.settings.get("uploadLimits")).toEqual(limits);
    await callFilesRoute(files.test, routes.updateUploadLimits, { cookie: files.adminCookie, payload: limits });
    expect(files.test.audited("settings.changed").map((event) => event.details)).toEqual([{ keys: ["uploadLimits"] }]);
    // They apply at once.
    expectTusProblem(await alice.create(1025, { name: "a.bin" }), 413, problemTypes.fileTooLarge);
  });

  it("are the admin's only, and validated", async () => {
    expectProblem(await callFilesRoute(files.test, routes.getUploadLimits, { cookie: files.userCookie }), 403, problemTypes.forbidden);
    expectProblem(
      await callFilesRoute(files.test, routes.updateUploadLimits, { cookie: files.userCookie, payload: limits }),
      403,
      problemTypes.forbidden,
    );
    expectProblem(
      await callFilesRoute(files.test, routes.updateUploadLimits, {
        cookie: files.adminCookie,
        payload: { ...limits, diskReserve: { percent: 80, bytes: 0 } },
      }),
      400,
      problemTypes.validationFailed,
    );
  });
});
