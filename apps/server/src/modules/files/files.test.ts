import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entriesPageSchema, entrySchema, problemTypes, routes } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFilesTestApp,
  callFilesRoute,
  expectProblem,
  makeFifo,
  type FilesCallOptions,
  type FilesTestApp,
} from "../../test-support/index.ts";
import { DOWNLOAD_CSP } from "./index.ts";

let files: FilesTestApp;

beforeEach(async () => {
  files = await buildFilesTestApp();
});
afterEach(async () => {
  await files.close();
});

type Route = (typeof routes)[keyof typeof routes];
const asUser = (route: Route, options: FilesCallOptions = {}) =>
  callFilesRoute(files.test, route, { cookie: files.userCookie, ...options });
const asAdmin = (route: Route, options: FilesCallOptions = {}) =>
  callFilesRoute(files.test, route, { cookie: files.adminCookie, params: files.resourceId, ...options });

describe("browsing", () => {
  it("lists folders first, then the rest by name, with a symlink as a link it never follows", async () => {
    mkdirSync(join(files.resourceDir, "b-folder"));
    mkdirSync(join(files.resourceDir, "a-folder"));
    writeFileSync(join(files.resourceDir, "z.txt"), "zz");
    writeFileSync(join(files.resourceDir, "c.txt"), "ccc");
    symlinkSync("/etc", join(files.resourceDir, "etc-link"));
    writeFileSync(join(files.resourceDir, ".nu-upload-0190"), "half");

    const response = await asAdmin(routes.listResourceEntries);
    expect(response.statusCode).toBe(200);
    const page = entriesPageSchema.parse(response.json());
    expect(page.path).toBe("");
    expect(page.nextCursor).toBeNull();
    expect(page.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ["a-folder", "folder", 0],
      ["b-folder", "folder", 0],
      ["c.txt", "file", 3],
      ["etc-link", "link", 0],
      ["z.txt", "file", 2],
    ]);
  });

  it("pages with a cursor", async () => {
    for (const name of ["d", "e"]) mkdirSync(join(files.homeDir, name));
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(files.homeDir, name), name);
    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await asUser(routes.listHomeEntries, { query: { limit: "2", ...(cursor === null ? {} : { cursor }) } });
      expect(response.statusCode).toBe(200);
      const page = entriesPageSchema.parse(response.json());
      names.push(...page.entries.map((entry) => entry.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(names).toEqual(["d", "e", "a.txt", "b.txt", "c.txt"]);
    expect(pages).toBe(3);
    expectProblem(await asUser(routes.listHomeEntries, { query: { cursor: "bm9wZQ" } }), 400, problemTypes.badRequest);
    expectProblem(await asUser(routes.listHomeEntries, { query: { limit: "201" } }), 400, problemTypes.validationFailed);
  });

  it("lists a subfolder of the user's home, normalised", async () => {
    mkdirSync(join(files.homeDir, "docs", "deep"), { recursive: true });
    const response = await asUser(routes.listHomeEntries, { query: { path: "docs//" } });
    expect(entriesPageSchema.parse(response.json())).toMatchObject({ path: "docs", entries: [{ name: "deep", kind: "folder" }] });
    expectProblem(await asUser(routes.listHomeEntries, { query: { path: "nope" } }), 404, problemTypes.notFound);
  });

  it("answers 404 for an unknown resource and 403 to a user on the admin's routes", async () => {
    expectProblem(
      await asAdmin(routes.listResourceEntries, { params: "01900000-0000-7000-8000-000000000000" }),
      404,
      problemTypes.notFound,
    );
    expectProblem(await asUser(routes.listResourceEntries, { params: files.resourceId }), 403, problemTypes.forbidden);
    expectProblem(await callFilesRoute(files.test, routes.listHomeEntries), 401, problemTypes.signInRequired);
  });
});

describe("a user reaches only their own home (T5 step 8)", () => {
  it("can't climb into another home", async () => {
    const bob = await files.addUser("bob");
    writeFileSync(join(bob.homeDir, "diary.txt"), "bob's");
    expectProblem(await asUser(routes.listHomeEntries, { query: { path: "../bob" } }), 422, problemTypes.pathRefused);
    expectProblem(await asUser(routes.downloadHomeFile, { query: { path: "../bob/diary.txt" } }), 422, problemTypes.pathRefused);
    expectProblem(await asUser(routes.deleteHomeEntry, { query: { path: "../bob/diary.txt" } }), 422, problemTypes.pathRefused);
    expect(existsSync(join(bob.homeDir, "diary.txt"))).toBe(true);
    // Each sees only their own home.
    writeFileSync(join(files.homeDir, "mine.txt"), "alice's");
    const bobs = entriesPageSchema.parse((await callFilesRoute(files.test, routes.listHomeEntries, { cookie: bob.cookie })).json());
    expect(bobs.entries.map((entry) => entry.name)).toEqual(["diary.txt"]);
  });

  it("reaches none of the admin's file routes, whatever resource or path it names", async () => {
    writeFileSync(join(files.resourceDir, "payroll.xlsx"), "the admin's");
    const calls = [
      [routes.listResourceEntries, { query: { path: "" } }],
      [routes.downloadResourceFile, { query: { path: "payroll.xlsx" } }],
      [routes.deleteResourceEntry, { query: { path: "payroll.xlsx" } }],
      [routes.createResourceFolder, { payload: { path: "", name: "mine" } }],
    ] as const;
    for (const [route, options] of calls) {
      for (const resourceId of [files.resourceId, "01900000-0000-7000-8000-000000000000"]) {
        expectProblem(await asUser(route, { ...options, params: resourceId }), 403, problemTypes.forbidden);
        expectProblem(await callFilesRoute(files.test, route, { ...options, params: resourceId }), 401, problemTypes.signInRequired);
      }
    }
    expect(existsSync(join(files.resourceDir, "payroll.xlsx"))).toBe(true);
    expect(existsSync(join(files.resourceDir, "mine"))).toBe(false);
  });

  it("can't name a resource in the query or the body", async () => {
    const resourceId = files.resourceId;
    expectProblem(await asUser(routes.listHomeEntries, { query: { resourceId } }), 400, problemTypes.validationFailed);
    expectProblem(await asUser(routes.downloadHomeFile, { query: { path: "a.txt", resourceId } }), 400, problemTypes.validationFailed);
    expectProblem(await asUser(routes.deleteHomeEntry, { query: { path: "a.txt", resourceId } }), 400, problemTypes.validationFailed);
    expectProblem(await asUser(routes.createHomeFolder, { payload: { name: "x", resourceId } }), 400, problemTypes.validationFailed);
    expect(existsSync(join(files.resourceDir, "x"))).toBe(false);
  });
});

/** Every admin file route, asked for `path`. */
const everyAdminFileRoute = (path: string) =>
  [
    [routes.listResourceEntries, { query: { path } }],
    [routes.downloadResourceFile, { query: { path } }],
    [routes.deleteResourceEntry, { query: { path, recursive: "true" } }],
    [routes.createResourceFolder, { payload: { path, name: "new" } }],
  ] as const;

describe("the admin's file routes", () => {
  beforeEach(() => {
    writeFileSync(join(files.homeDir, "diary.txt"), "alice's");
    writeFileSync(join(files.resourceDir, "kept.txt"), "kept");
    symlinkSync(join(files.homeDir, ".."), join(files.resourceDir, "homes-link"));
  });

  it("answer 404 for a resource that doesn't exist, or no longer does", async () => {
    const gone = join(files.resourceDir, "..", "gone");
    mkdirSync(gone);
    const other = await files.test.services.resources.add({ kind: "local", name: "Gone", localPath: gone }, { kind: "system" });
    await files.test.services.resources.remove(other.id, { kind: "system" });
    for (const resourceId of ["01900000-0000-7000-8000-000000000000", other.id]) {
      for (const [route, options] of everyAdminFileRoute("kept.txt")) {
        expectProblem(await asAdmin(route, { ...options, params: resourceId }), 404, problemTypes.notFound);
      }
    }
    expect(existsSync(join(files.resourceDir, "kept.txt"))).toBe(true);
  });

  it.each<[string, string, string]>([
    ["../ to a user's home", "../homes/alice/diary.txt", "invalid"],
    ["an absolute path", "/etc", "invalid"],
    ["a symlink to the homes", "homes-link/alice/diary.txt", "symlink"],
  ])("keep the path inside the resource: %s", async (_case, path, reason) => {
    for (const [route, options] of everyAdminFileRoute(path)) {
      expect(expectProblem(await asAdmin(route, options), 422, problemTypes.pathRefused).reason).toBe(reason);
    }
    expect(existsSync(join(files.homeDir, "diary.txt"))).toBe(true);
    expect(existsSync(join(files.homeDir, "new"))).toBe(false);
  });
});

describe("path safety through the files routes (T5)", () => {
  beforeEach(() => {
    mkdirSync(join(files.homeDir, "docs"));
    writeFileSync(join(files.homeDir, "docs", "a.txt"), "inside");
    writeFileSync(join(files.homeDir, "Café.txt"), "nfc");
    symlinkSync("/etc", join(files.homeDir, "etc"));
    const sibling = join(files.homeDir, "..", "sibling");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "secret.txt"), "theirs");
    symlinkSync(sibling, join(files.homeDir, "sibling-link"));
    makeFifo(join(files.homeDir, "pipe"));
  });

  it.each<[string, string, number, string]>([
    ["../", "../", 422, "invalid"],
    ["%2e%2e/ (decoded first)", "%2e%2e/docs", 422, "invalid"],
    ["a/../../b", "docs/../../b", 422, "invalid"],
    ["..\\", "..\\docs", 422, "invalid"],
    ["an absolute path", "/etc/passwd", 422, "invalid"],
    ["a NUL byte", "docs/a.txt\0.png", 422, "invalid"],
    ["a control character", "docs/a\u0001.txt", 422, "invalid"],
    ["an overlong name", `docs/${"a".repeat(256)}`, 422, "too-long"],
    ["a symlink to /etc", "etc/passwd", 422, "symlink"],
    ["a symlink to a sibling folder", "sibling-link/secret.txt", 422, "symlink"],
    ["a FIFO", "pipe", 422, "special-file"],
    ["a missing file", "docs/none.txt", 404, "not-found"],
  ])("refuses %s on every route", async (_case, path, status, reason) => {
    const type = status === 404 ? problemTypes.notFound : problemTypes.pathRefused;
    // The %2e%2e case is sent encoded, as a browser would: Fastify decodes the query first.
    const query = path.startsWith("%2e") ? decodeURIComponent(path) : path;
    const folder = await asUser(routes.createHomeFolder, { payload: { path: query, name: "new" } });
    expect(expectProblem(folder, status, type).reason).toBe(reason);
    for (const route of [routes.downloadHomeFile, routes.deleteHomeEntry]) {
      expect(expectProblem(await asUser(route, { query: { path: query } }), status, type).reason).toBe(reason);
    }
    expect(expectProblem(await asUser(routes.listHomeEntries, { query: { path: query } }), status, type).reason).toBe(reason);
    expect(existsSync(join(files.homeDir, "docs", "a.txt"))).toBe(true);
    expect(existsSync(join(files.homeDir, "..", "sibling", "secret.txt"))).toBe(true);
  });

  it("finds an NFD name as its NFC file", async () => {
    const response = await asUser(routes.downloadHomeFile, { query: { path: "Café.txt" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("nfc");
  });
});

describe("new folders", () => {
  it("makes a folder in the home, refusing a taken or a bad name", async () => {
    const response = await asUser(routes.createHomeFolder, { payload: { path: "", name: "Docs" } });
    expect(response.statusCode).toBe(201);
    expect(entrySchema.parse(response.json())).toMatchObject({ name: "Docs", kind: "folder", size: 0 });
    expect(statSync(join(files.homeDir, "Docs")).isDirectory()).toBe(true);
    expectProblem(await asUser(routes.createHomeFolder, { payload: { name: "Docs" } }), 409, problemTypes.nameTaken);
    writeFileSync(join(files.homeDir, "file"), "x");
    expectProblem(await asUser(routes.createHomeFolder, { payload: { name: "file" } }), 409, problemTypes.nameTaken);
    expect(expectProblem(await asUser(routes.createHomeFolder, { payload: { name: "CON" } }), 422, problemTypes.pathRefused).reason).toBe(
      "reserved-name",
    );
    expect(expectProblem(await asUser(routes.createHomeFolder, { payload: { name: "a/b" } }), 422, problemTypes.pathRefused).reason).toBe(
      "slash",
    );
    expectProblem(await asUser(routes.createHomeFolder, { payload: { path: "missing", name: "x" } }), 404, problemTypes.notFound);
  });

  it("makes a folder inside a resource's folder for the admin", async () => {
    mkdirSync(join(files.resourceDir, "shared"));
    const response = await asAdmin(routes.createResourceFolder, { payload: { path: "shared", name: "Reports 2026" } });
    expect(response.statusCode).toBe(201);
    expect(statSync(join(files.resourceDir, "shared", "Reports 2026")).isDirectory()).toBe(true);
  });
});

const content = "hello world";
const download = (headers: Record<string, string> = {}) => asUser(routes.downloadHomeFile, { query: { path: "Grüße (1).txt" }, headers });

describe("downloads", () => {
  beforeEach(() => {
    writeFileSync(join(files.homeDir, "Grüße (1).txt"), content);
    writeFileSync(join(files.resourceDir, "report.pdf"), "%PDF-1.7");
  });

  it("sends the whole file as an attachment that never renders", async () => {
    const response = await download();
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(content);
    expect(response.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="Gr__e (1).txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%281%29.txt`,
      "x-content-type-options": "nosniff",
      "content-security-policy": DOWNLOAD_CSP,
      "accept-ranges": "bytes",
      "content-length": String(content.length),
    });
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers.etag).toMatch(/^"[0-9a-z]+-[0-9a-z]+-[0-9a-z]+"$/);
    expect(new Date(String(response.headers["last-modified"])).getTime()).toBeGreaterThan(0);

    const admin = await asAdmin(routes.downloadResourceFile, { query: { path: "report.pdf" } });
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toBe("%PDF-1.7");
    expect(admin.headers["content-type"]).toBe("application/octet-stream");
  });

  it("answers one range with 206", async () => {
    const response = await download({ range: "bytes=0-4" });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("hello");
    expect(response.headers["content-range"]).toBe(`bytes 0-4/${content.length}`);
    expect(response.headers["content-length"]).toBe("5");
    expect((await download({ range: "bytes=6-" })).body).toBe("world");
    expect((await download({ range: "bytes=6-1000" })).body).toBe("world");
  });

  it("answers a suffix range", async () => {
    const response = await download({ range: "bytes=-5" });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("world");
    expect(response.headers["content-range"]).toBe(`bytes 6-10/${content.length}`);
    expect((await download({ range: "bytes=-100" })).body).toBe(content);
  });

  it("answers an unsatisfiable range with 416 and the size", async () => {
    for (const range of ["bytes=11-", "bytes=100-200", "bytes=-0"]) {
      const response = await download({ range });
      expectProblem(response, 416, problemTypes.rangeNotSatisfiable);
      expect(response.headers["content-range"]).toBe(`bytes */${content.length}`);
    }
  });

  it("sends the whole file for several ranges, or one it can't read", async () => {
    for (const range of ["bytes=0-1,3-4", "bytes=5-2", "items=0-1", "bytes=x-"]) {
      const response = await download({ range });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(content);
    }
  });

  it("honours If-Range only while it names this version", async () => {
    const { etag, "last-modified": lastModified } = (await download()).headers;
    expect((await download({ range: "bytes=0-4", "if-range": String(etag) })).statusCode).toBe(206);
    expect((await download({ range: "bytes=0-4", "if-range": String(lastModified) })).statusCode).toBe(206);
    const stale = await download({ range: "bytes=0-4", "if-range": '"stale-1-2"' });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toBe(content);
    expect((await download({ range: "bytes=0-4", "if-range": "Tue, 01 Jan 2002 00:00:00 GMT" })).statusCode).toBe(200);
    expect((await download({ range: "bytes=0-4", "if-range": `W/${String(etag)}` })).statusCode).toBe(200);
  });

  it("refuses a folder", async () => {
    mkdirSync(join(files.homeDir, "docs"));
    expect(expectProblem(await asUser(routes.downloadHomeFile, { query: { path: "docs" } }), 422, problemTypes.pathRefused).reason).toBe(
      "not-a-file",
    );
  });
});

describe("deleting", () => {
  it("deletes a file, and audits it", async () => {
    writeFileSync(join(files.homeDir, "a.txt"), "x");
    const response = await asUser(routes.deleteHomeEntry, { query: { path: "a.txt" } });
    expect(response.statusCode).toBe(204);
    expect(existsSync(join(files.homeDir, "a.txt"))).toBe(false);
    const [event] = files.test.audited("file.deleted");
    expect(event).toMatchObject({
      actorKind: "account",
      actorAccountId: files.user.id,
      targetKind: null,
      outcome: "succeeded",
      details: { resourceId: null, path: "a.txt", kind: "file", recursive: false },
    });
  });

  it("needs recursive for a folder that holds anything", async () => {
    mkdirSync(join(files.homeDir, "full", "deep"), { recursive: true });
    writeFileSync(join(files.homeDir, "full", "deep", "a.txt"), "x");
    mkdirSync(join(files.homeDir, "empty"));
    expectProblem(await asUser(routes.deleteHomeEntry, { query: { path: "full" } }), 409, problemTypes.folderNotEmpty);
    expect(existsSync(join(files.homeDir, "full", "deep", "a.txt"))).toBe(true);
    expect((await asUser(routes.deleteHomeEntry, { query: { path: "empty" } })).statusCode).toBe(204);
    expect((await asUser(routes.deleteHomeEntry, { query: { path: "full", recursive: "true" } })).statusCode).toBe(204);
    expect(existsSync(join(files.homeDir, "full"))).toBe(false);
    expect(files.test.audited("file.deleted").map((event) => event.details)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "full", kind: "folder", recursive: true })]),
    );
  });

  it("never deletes the top folder", async () => {
    expectProblem(await asUser(routes.deleteHomeEntry, { query: { path: "" } }), 400, problemTypes.validationFailed);
    expect(
      expectProblem(await asUser(routes.deleteHomeEntry, { query: { path: "/", recursive: "true" } }), 422, problemTypes.pathRefused)
        .reason,
    ).toBe("invalid");
    expect(
      expectProblem(await asAdmin(routes.deleteResourceEntry, { query: { path: "//", recursive: "true" } }), 422, problemTypes.pathRefused)
        .reason,
    ).toBe("invalid");
    expect(existsSync(files.homeDir)).toBe(true);
    expect(existsSync(files.resourceDir)).toBe(true);
  });

  it("deletes in a resource for the admin, naming the resource in the audit", async () => {
    writeFileSync(join(files.resourceDir, "old.log"), "x");
    expect((await asAdmin(routes.deleteResourceEntry, { query: { path: "old.log" } })).statusCode).toBe(204);
    expect(files.test.audited("file.deleted")[0]).toMatchObject({
      targetKind: "resource",
      targetId: files.resourceId,
      details: { resourceId: files.resourceId, path: "old.log" },
    });
  });
});
