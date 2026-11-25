import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entriesPageSchema, problemTypes, publicShareLinkSchema, routes, shareLinkSchema } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildShareLinksTestApp,
  buildTestApp,
  callFilesRoute,
  cookieFromSetCookie,
  expectProblem,
  makeFifo,
  makeTempDir,
  setCookiesOf,
  sharedContent,
  tusClient,
  viaProxy,
  writeWebRoot,
  type ShareLinksTestApp,
} from "../../test-support/index.ts";
import { tableRows } from "../../test-support/sessions.ts";
import { DOWNLOAD_CSP } from "../files/index.ts";
import { hashToken, MINUTE_MS, newToken } from "../platform/index.ts";
import { SHARE_ROBOTS_TAG } from "./index.ts";
import { UNLOCK_LIFETIME_MS } from "./public.ts";

let app: ShareLinksTestApp;

beforeEach(async () => {
  app = await buildShareLinksTestApp();
});
afterEach(async () => {
  await app.close();
});

const HOUR_MS = 60 * MINUTE_MS;
const linkPassword = "open sesame 42";

const describeLink = (token: string, options: { cookie?: string; ip?: string } = {}) =>
  app.asPublic(routes.getPublicShareLink, token, options);
const entries = (token: string, path?: string, options: { cookie?: string; ip?: string } = {}) =>
  app.asPublic(routes.listShareLinkEntries, token, { ...options, ...(path === undefined ? {} : { query: { path } }) });
const content = (token: string, path?: string, options: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}) =>
  app.asPublic(routes.downloadShareLinkContent, token, { ...options, ...(path === undefined ? {} : { query: { path } }) });
const unlock = (token: string, password: string, options: { ip?: string } = {}) =>
  app.asPublic(routes.unlockShareLink, token, { ...options, payload: { password } });

const unlockCookieOf = async (token: string): Promise<string> => {
  const response = await unlock(token, linkPassword);
  expect(response.statusCode).toBe(204);
  return cookieFromSetCookie(setCookiesOf(response)[0] ?? "");
};

describe("the public share page", () => {
  it("shows a file link's name, kind, size and expiry, and never its resource or path", async () => {
    const { token, shareLink } = await app.createLink({ path: "docs/report.pdf" });
    const response = await describeLink(token);
    expect(response.statusCode).toBe(200);
    expect(publicShareLinkSchema.parse(response.json())).toEqual({
      name: "report.pdf",
      kind: "file",
      size: sharedContent.report.length,
      expiresAt: shareLink.expiresAt,
      passwordRequired: false,
    });
    for (const hidden of [app.resourceId, shareLink.id, "docs", "Files", app.resourceDir]) expect(response.body).not.toContain(hidden);
  });

  it("shows a folder link with no size, and whether it needs its password", async () => {
    const { token } = await app.createLink({ path: "docs/sub", password: linkPassword, noExpiry: true });
    const response = await describeLink(token);
    expect(response.json()).toEqual({ name: "sub", kind: "folder", size: null, expiresAt: null, passwordRequired: true });
    expect(response.body).not.toContain("docs");
    expect((await describeLink(token, { cookie: await unlockCookieOf(token) })).json()).toMatchObject({ passwordRequired: false });
  });
});

/** Each case comes from an IP of its own, so the invalid-token limit never answers instead. */
const answers = async (token: string, ip: string) =>
  Promise.all([
    describeLink(token, { ip }),
    entries(token, undefined, { ip }),
    content(token, undefined, { ip }),
    content(token, "report.pdf", { ip }),
    unlock(token, linkPassword, { ip }),
  ]).then((responses) => responses.map((response) => [response.statusCode, response.headers["content-type"], response.body]));

describe("an invalid link", () => {
  it("answers exactly like an unknown token when malformed, expired, revoked or its item is gone", async () => {
    const unknown = await answers(newToken(), "198.51.100.1");
    expect(unknown).toHaveLength(5);
    for (const [status, , body] of unknown) {
      expect(status).toBe(404);
      expect(JSON.parse(String(body))).toEqual({ type: problemTypes.shareLinkInvalid, title: "This link is not valid", status: 404 });
    }

    expect(await answers("not-a-token", "198.51.100.2")).toEqual(unknown);
    expect(await answers("A".repeat(100), "198.51.100.3")).toEqual(unknown);

    const expiring = await app.createLink({ path: "docs", expiresAt: new Date(app.test.clock.now().getTime() + HOUR_MS).toISOString() });
    const revoked = await app.createLink({ path: "docs", password: linkPassword });
    const removedFile = await app.createLink({ path: "single.txt" });
    const removedFolder = await app.createLink({ path: "docs/sub" });
    const swapped = await app.createLink({ path: "docs/report.pdf" });
    expect((await describeLink(expiring.token)).statusCode).toBe(200);

    app.test.clock.advance(HOUR_MS);
    expect(await answers(expiring.token, "198.51.100.4")).toEqual(unknown);

    expect((await app.asAdmin(routes.revokeShareLink, { params: revoked.shareLink.id })).statusCode).toBe(200);
    expect(await answers(revoked.token, "198.51.100.5")).toEqual(unknown);

    rmSync(join(app.resourceDir, "single.txt"));
    expect(await answers(removedFile.token, "198.51.100.6")).toEqual(unknown);
    rmSync(join(app.resourceDir, "docs", "sub"), { recursive: true });
    expect(await answers(removedFolder.token, "198.51.100.7")).toEqual(unknown);
    // A folder where the shared file was is not the shared file.
    rmSync(join(app.resourceDir, "docs", "report.pdf"));
    mkdirSync(join(app.resourceDir, "docs", "report.pdf"));
    expect(await answers(swapped.token, "198.51.100.8")).toEqual(unknown);
  });

  it("is checked again between the range requests of one download", async () => {
    const expiresAt = new Date(app.test.clock.now().getTime() + HOUR_MS).toISOString();
    const expiring = await app.createLink({ path: "docs/report.pdf", expiresAt });
    const first = await content(expiring.token, undefined, { headers: { range: "bytes=0-4" } });
    expect(first.statusCode).toBe(206);
    expect(first.body).toBe("01234");
    app.test.clock.advance(HOUR_MS);
    expectProblem(await content(expiring.token, undefined, { headers: { range: "bytes=5-" } }), 404, problemTypes.shareLinkInvalid);

    const revoked = await app.createLink({ path: "docs/report.pdf" });
    expect((await content(revoked.token, undefined, { headers: { range: "bytes=0-4" } })).statusCode).toBe(206);
    expect((await app.asAdmin(routes.revokeShareLink, { params: revoked.shareLink.id })).statusCode).toBe(200);
    expectProblem(await content(revoked.token, undefined, { headers: { range: "bytes=5-" } }), 404, problemTypes.shareLinkInvalid);

    // A new password ends the unlock the download started with.
    const locked = await app.createLink({ path: "docs/report.pdf", password: linkPassword });
    const cookie = await unlockCookieOf(locked.token);
    expect((await content(locked.token, undefined, { cookie, headers: { range: "bytes=0-4" } })).statusCode).toBe(206);
    const changed = await app.asAdmin(routes.changeShareLink, { params: locked.shareLink.id, payload: { password: "another secret" } });
    expect(changed.statusCode).toBe(200);
    expectProblem(
      await content(locked.token, undefined, { cookie, headers: { range: "bytes=5-" } }),
      401,
      problemTypes.shareLinkPasswordRequired,
    );
  });

  it("is gone when its file or folder is swapped for a symlink, even to a place inside the resource", async () => {
    const file = await app.createLink({ path: "docs/report.pdf" });
    const folder = await app.createLink({ path: "docs/sub" });
    expect((await content(file.token)).statusCode).toBe(200);
    expect((await entries(folder.token)).statusCode).toBe(200);

    rmSync(join(app.resourceDir, "docs", "report.pdf"));
    symlinkSync(join(app.resourceDir, "single.txt"), join(app.resourceDir, "docs", "report.pdf"));
    rmSync(join(app.resourceDir, "docs", "sub"), { recursive: true });
    symlinkSync(app.homeDir, join(app.resourceDir, "docs", "sub"));
    expectProblem(await content(file.token), 404, problemTypes.shareLinkInvalid);
    expectProblem(await entries(folder.token), 404, problemTypes.shareLinkInvalid);
    expectProblem(await content(folder.token, "nested.txt"), 404, problemTypes.shareLinkInvalid);
  });
});

/** Joins `Cookie` header values, as a browser sends every cookie in one header. */
const cookies = (...values: (string | undefined)[]): string | undefined => {
  const present = values.filter((value) => value !== undefined && value !== "");
  return present.length === 0 ? undefined : present.join("; ");
};
const withCookie = (cookie: string | undefined) => (cookie === undefined ? {} : { cookie });

/** Every route refuses alike, before the password, and no answer tells anything about the item. */
const expectRefused = async (token: string, cookie: string | undefined, status: number, type: string) => {
  const responses = [
    await describeLink(token, withCookie(cookie)),
    await entries(token, undefined, withCookie(cookie)),
    await content(token, "report.pdf", withCookie(cookie)),
    await app.asPublic(routes.unlockShareLink, token, { ...withCookie(cookie), payload: { password: linkPassword } }),
  ];
  for (const response of responses) {
    expectProblem(response, status, type);
    expect(setCookiesOf(response)).toEqual([]);
    for (const hidden of ["docs", "report", "sub", "folder", "size", String(sharedContent.report.length)]) {
      expect(response.body).not.toContain(hidden);
    }
  }
  expect(responses.map((response) => response.body).every((body) => body === responses[0]?.body)).toBe(true);
};

/** The caller opens the folder link: its password still needed, then the entries and a download. */
const expectOpens = async (token: string, cookie: string) => {
  expect((await describeLink(token, { cookie })).json()).toMatchObject({ name: "docs", passwordRequired: true });
  expectProblem(await entries(token, undefined, { cookie }), 401, problemTypes.shareLinkPasswordRequired);
  expectProblem(await content(token, "report.pdf", { cookie }), 401, problemTypes.shareLinkPasswordRequired);
  const unlocked = await app.asPublic(routes.unlockShareLink, token, { cookie, payload: { password: linkPassword } });
  expect(unlocked.statusCode).toBe(204);
  const both = cookies(cookie, cookieFromSetCookie(setCookiesOf(unlocked)[0] ?? "")) ?? "";
  expect((await describeLink(token, { cookie: both })).json()).toMatchObject({ passwordRequired: false });
  expect((await entries(token, undefined, { cookie: both })).statusCode).toBe(200);
  expect((await content(token, "report.pdf", { cookie: both })).body).toBe(sharedContent.report);
};

describe("a link's access", () => {
  it("lets anyone open an Anyone link, signed out", async () => {
    const { token } = await app.createLink({ path: "docs", access: "anyone" });
    expect((await describeLink(token)).statusCode).toBe(200);
    expect((await entries(token)).statusCode).toBe(200);
    expect((await content(token, "report.pdf")).body).toBe(sharedContent.report);
  });

  it("needs a full sign-in for a Signed-in users link, a user's or the admin's", async () => {
    const { token } = await app.createLink({ path: "docs", password: linkPassword, access: "signed-in" });
    await expectRefused(token, undefined, 401, problemTypes.shareLinkSignInRequired);
    const pending = app.test.startSession(app.admin, { state: "pendingSecondFactor" });
    await expectRefused(token, pending, 401, problemTypes.shareLinkSignInRequired);
    expect(JSON.parse((await describeLink(token)).body)).toEqual({
      type: problemTypes.shareLinkSignInRequired,
      title: "Sign in to open this link",
      status: 401,
    });
    await expectOpens(token, app.userCookie);
    await expectOpens(token, app.adminCookie);
    expect(app.test.audited("share-link.password-failed")).toEqual([]);
  });

  it("opens a Selected users link only to the listed users and the admin", async () => {
    const bob = await app.addUser("bob");
    const { token } = await app.createLink({
      path: "docs",
      password: linkPassword,
      access: "selected-users",
      allowedUserIds: [app.user.id],
    });
    await expectRefused(token, undefined, 401, problemTypes.shareLinkSignInRequired);
    await expectRefused(
      token,
      app.test.startSession(app.admin, { state: "pendingSecondFactor" }),
      401,
      problemTypes.shareLinkSignInRequired,
    );
    await expectRefused(token, bob.cookie, 403, problemTypes.shareLinkNotAllowed);
    expect(JSON.parse((await describeLink(token, { cookie: bob.cookie })).body)).toEqual({
      type: problemTypes.shareLinkNotAllowed,
      title: "This link is not shared with you",
      status: 403,
    });
    await expectOpens(token, app.userCookie);
    await expectOpens(token, app.adminCookie);
    // A listed user's unlock doesn't open the link for another account in the same browser.
    const unlocked = await app.asPublic(routes.unlockShareLink, token, { cookie: app.userCookie, payload: { password: linkPassword } });
    const unlockCookie = cookieFromSetCookie(setCookiesOf(unlocked)[0] ?? "");
    await expectRefused(token, cookies(bob.cookie, unlockCookie), 403, problemTypes.shareLinkNotAllowed);
    await expectRefused(token, unlockCookie, 401, problemTypes.shareLinkSignInRequired);
  });

  it("comes after the token: an invalid one answers the same 404, byte for byte", async () => {
    const unknown = await answers(newToken(), "198.51.100.11");
    const restricted = { access: "selected-users" as const, allowedUserIds: [app.user.id] };
    const expiring = await app.createLink({
      path: "docs",
      ...restricted,
      expiresAt: new Date(app.test.clock.now().getTime() + HOUR_MS).toISOString(),
    });
    const revoked = await app.createLink({ path: "docs", access: "signed-in" });
    expectProblem(await describeLink(expiring.token), 401, problemTypes.shareLinkSignInRequired);
    expect((await app.asAdmin(routes.revokeShareLink, { params: revoked.shareLink.id })).statusCode).toBe(200);
    expect(await answers(revoked.token, "198.51.100.12")).toEqual(unknown);
    app.test.clock.advance(HOUR_MS);
    expect(await answers(expiring.token, "198.51.100.13")).toEqual(unknown);
    expect(await answers("not-a-token", "198.51.100.14")).toEqual(unknown);
  });

  it("is checked again on every request, a download's range requests included", async () => {
    const bob = await app.addUser("bob");
    const { token, shareLink } = await app.createLink({
      path: "docs/report.pdf",
      access: "selected-users",
      allowedUserIds: [app.user.id],
    });
    const range = (cookie: string | undefined, bytes: string) =>
      content(token, undefined, { ...withCookie(cookie), headers: { range: bytes } });
    const change = (payload: object) => app.asAdmin(routes.changeShareLink, { params: shareLink.id, payload });
    expect((await range(app.userCookie, "bytes=0-4")).statusCode).toBe(206);
    expect((await change({ access: "selected-users", allowedUserIds: [bob.account.id] })).statusCode).toBe(200);
    expectProblem(await range(app.userCookie, "bytes=5-"), 403, problemTypes.shareLinkNotAllowed);
    expect((await range(bob.cookie, "bytes=5-")).statusCode).toBe(206);
    expect((await change({ access: "anyone" })).statusCode).toBe(200);
    expect((await range(undefined, "bytes=5-")).statusCode).toBe(206);
    expect((await change({ access: "signed-in" })).statusCode).toBe(200);
    expectProblem(await range(undefined, "bytes=5-"), 401, problemTypes.shareLinkSignInRequired);
    expect((await range(app.userCookie, "bytes=5-")).statusCode).toBe(206);
  });

  it("names who downloaded a link only signed-in accounts open", async () => {
    const restricted = await app.createLink({ path: "docs/report.pdf", access: "signed-in" });
    const open = await app.createLink({ path: "single.txt" });
    expect((await content(restricted.token, undefined, { cookie: app.userCookie })).statusCode).toBe(200);
    expect((await content(open.token, undefined, { cookie: app.userCookie })).statusCode).toBe(200);
    const byLink = new Map(app.test.audited("share-link.downloaded").map((event) => [event.targetId, event]));
    expect(byLink.get(restricted.shareLink.id)).toMatchObject({ actorKind: "account", actorAccountId: app.user.id });
    expect(byLink.get(open.shareLink.id)).toMatchObject({ actorKind: "share-link", actorAccountId: null });
  });
});

describe("a link's password", () => {
  it("is needed for the entries and the content, until it is unlocked", async () => {
    const folder = await app.createLink({ path: "docs", password: linkPassword });
    const file = await app.createLink({ path: "single.txt", password: linkPassword });
    expectProblem(await entries(folder.token), 401, problemTypes.shareLinkPasswordRequired);
    expectProblem(await content(folder.token, "report.pdf"), 401, problemTypes.shareLinkPasswordRequired);
    expectProblem(await content(file.token), 401, problemTypes.shareLinkPasswordRequired);
    expectProblem(await unlock(file.token, "not the password"), 401, problemTypes.shareLinkPasswordWrong);

    const cookie = await unlockCookieOf(folder.token);
    expect((await entries(folder.token, undefined, { cookie })).statusCode).toBe(200);
    expect((await content(folder.token, "report.pdf", { cookie })).body).toBe(sharedContent.report);
    // One link's unlock never opens another.
    expectProblem(await content(file.token, undefined, { cookie }), 401, problemTypes.shareLinkPasswordRequired);
    const forged = `__Host-nu_unlock_${file.shareLink.id}=${newToken()}`;
    expectProblem(await content(file.token, undefined, { cookie: forged }), 401, problemTypes.shareLinkPasswordRequired);
    // Nor does its real unlock token, sent under the other link's cookie name.
    const borrowed = `__Host-nu_unlock_${file.shareLink.id}=${cookie.slice(cookie.indexOf("=") + 1)}`;
    expectProblem(await content(file.token, undefined, { cookie: borrowed }), 401, problemTypes.shareLinkPasswordRequired);
    expect((await describeLink(file.token, { cookie: borrowed })).json()).toMatchObject({ passwordRequired: true });

    const plain = await app.createLink({ path: "single.txt" });
    expectProblem(await unlock(plain.token, linkPassword), 409, problemTypes.badRequest);
  });

  it("unlocks with a __Host- cookie for 12 hours, stored as its SHA-256", async () => {
    const { token, shareLink } = await app.createLink({ path: "single.txt", password: linkPassword, noExpiry: true });
    const response = await unlock(token, linkPassword);
    expect(response.statusCode).toBe(204);
    const [setCookie, ...others] = setCookiesOf(response);
    expect(others).toEqual([]);
    const match = new RegExp(`^__Host-nu_unlock_${shareLink.id}=([A-Za-z0-9_-]{43}); (.*)$`).exec(setCookie ?? "");
    expect(match).not.toBeNull();
    const [, value = "", attributes = ""] = match ?? [];
    expect(attributes.split("; ").toSorted()).toEqual([
      "HttpOnly",
      `Max-Age=${UNLOCK_LIFETIME_MS / 1000}`,
      "Path=/",
      "SameSite=Strict",
      "Secure",
    ]);
    expect(attributes).not.toMatch(/Domain/i);
    expect(UNLOCK_LIFETIME_MS).toBe(12 * HOUR_MS);

    const [row] = tableRows(app.test, "share_link_unlocks");
    expect(row).toMatchObject({
      share_link_id: shareLink.id,
      unlock_hash: hashToken(value),
      expires_at: new Date(app.test.clock.now().getTime() + 12 * HOUR_MS).toISOString(),
    });
    expect(JSON.stringify(tableRows(app.test, "share_link_unlocks"))).not.toContain(value);

    const cookie = cookieFromSetCookie(setCookie ?? "");
    app.test.clock.advance(12 * HOUR_MS - 1000);
    expect((await content(token, undefined, { cookie })).statusCode).toBe(200);
    app.test.clock.advance(1000);
    expectProblem(await content(token, undefined, { cookie }), 401, problemTypes.shareLinkPasswordRequired);
  });

  it("unlocks no longer than the link lasts", async () => {
    const expiresAt = new Date(app.test.clock.now().getTime() + HOUR_MS).toISOString();
    const { token } = await app.createLink({ path: "single.txt", password: linkPassword, expiresAt });
    const response = await unlock(token, linkPassword);
    expect(setCookiesOf(response)[0]).toContain("; Max-Age=3600");
    expect(tableRows(app.test, "share_link_unlocks")[0]?.["expires_at"]).toBe(expiresAt);
  });

  it("records each wrong password, never the password itself", async () => {
    const { token, shareLink } = await app.createLink({ path: "single.txt", password: linkPassword });
    expectProblem(await unlock(token, "guess number one", { ip: "203.0.113.9" }), 401, problemTypes.shareLinkPasswordWrong);
    expect(app.test.audited("share-link.password-failed")).toMatchObject([
      {
        actorKind: "anonymous",
        targetKind: "share-link",
        targetId: shareLink.id,
        outcome: "failed",
        ip: "203.0.113.9",
        details: { limitReached: false },
      },
    ]);
    expect(JSON.stringify(app.test.audited())).not.toContain("guess number one");
  });
});

describe("a folder link", () => {
  it("lists inside the shared folder only, with paths relative to it", async () => {
    const { token } = await app.createLink({ path: "docs" });
    const top = entriesPageSchema.parse((await entries(token)).json());
    expect(top.path).toBe("");
    expect(top.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["sub", "folder"],
      ["report.pdf", "file"],
    ]);
    const sub = entriesPageSchema.parse((await entries(token, "sub/")).json());
    expect(sub).toMatchObject({ path: "sub", entries: [{ name: "nested.txt", kind: "file" }] });

    const download = await content(token, "sub/nested.txt");
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(sharedContent.nested);
    expect(download.headers["content-disposition"]).toContain('filename="nested.txt"');
    expect(app.test.audited("share-link.downloaded")[0]?.details).toEqual({ path: "sub/nested.txt" });

    expectProblem(await content(token), 404, problemTypes.notFound);
    expectProblem(await content(token, "sub"), 404, problemTypes.notFound);
    expectProblem(await entries(token, "report.pdf"), 422, problemTypes.pathRefused);
  });

  describe("path safety (T5)", () => {
    let token: string;

    beforeEach(async () => {
      const docs = join(app.resourceDir, "docs");
      writeFileSync(join(app.resourceDir, "outside.txt"), "not shared");
      writeFileSync(join(docs, "Café.txt"), "nfc");
      symlinkSync("/etc", join(docs, "etc"));
      symlinkSync(app.resourceDir, join(docs, "up"));
      symlinkSync(join(app.resourceDir, "outside.txt"), join(docs, "outside-link.txt"));
      makeFifo(join(docs, "pipe"));
      token = (await app.createLink({ path: "docs" })).token;
    });

    it.each<[string, string, number, string]>([
      ["../", "../", 422, "invalid"],
      ["../ to a file of the resource", "../outside.txt", 422, "invalid"],
      ["%2e%2e/ (decoded first)", "%2e%2e/outside.txt", 422, "invalid"],
      ["a/../../b", "sub/../../outside.txt", 422, "invalid"],
      ["..\\", "..\\outside.txt", 422, "invalid"],
      ["an absolute path", "/etc/passwd", 422, "invalid"],
      ["the resource's own path", "/docs/report.pdf", 422, "invalid"],
      ["a NUL byte", "report.pdf\0.png", 422, "invalid"],
      ["a control character", "sub/a\u0001.txt", 422, "invalid"],
      ["an overlong name", `sub/${"a".repeat(256)}`, 422, "too-long"],
      ["a symlink to /etc", "etc/passwd", 422, "symlink"],
      ["a symlink up to the resource", "up/outside.txt", 422, "symlink"],
      ["a symlink to a file outside", "outside-link.txt", 422, "symlink"],
      ["a FIFO", "pipe", 422, "special-file"],
      ["a missing file", "sub/none.txt", 404, "not-found"],
    ])("refuses %s on the entries and the content", async (_case, path, status, reason) => {
      const type = status === 404 ? problemTypes.notFound : problemTypes.pathRefused;
      const query = path.startsWith("%2e") ? decodeURIComponent(path) : path;
      expect(expectProblem(await content(token, query), status, type).reason).toBe(reason);
      expect(expectProblem(await entries(token, query), status, type).reason).toBe(reason);
      expect(app.test.audited("share-link.downloaded")).toEqual([]);
    });

    it("finds an NFD name as its NFC file", async () => {
      expect((await content(token, "Café.txt")).body).toBe("nfc");
    });
  });
});

describe("a file link", () => {
  it("serves only its own file, and has no entries", async () => {
    const { token } = await app.createLink({ path: "docs/report.pdf" });
    const download = await content(token, "");
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(sharedContent.report);
    expect(download.headers["content-disposition"]).toContain('filename="report.pdf"');
    for (const path of ["report.pdf", "sub/nested.txt", "../single.txt", "/"])
      expectProblem(await content(token, path), 404, problemTypes.notFound);
    expectProblem(await entries(token), 404, problemTypes.shareLinkInvalid);
    expectProblem(await entries(token, "sub"), 404, problemTypes.shareLinkInvalid);
  });
});

describe("downloads", () => {
  it("resume with a range, counting only a download from the first byte", async () => {
    const { token, shareLink } = await app.createLink({ path: "docs/report.pdf" });
    const counted = () => shareLinkSchema.parse(app.test.services.shareLinks.get(shareLink.id).shareLink);

    const whole = await content(token, undefined, { ip: "198.51.100.20" });
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe(sharedContent.report);
    expect(whole.headers).toMatchObject({ "accept-ranges": "bytes", "content-type": "application/octet-stream" });
    expect(counted()).toMatchObject({ downloadCount: 1, lastUsedAt: app.test.clock.now().toISOString() });
    const [event] = app.test.audited("share-link.downloaded");
    expect(event).toMatchObject({
      actorKind: "share-link",
      actorAccountId: null,
      targetKind: "share-link",
      targetId: shareLink.id,
      outcome: "succeeded",
      ip: "198.51.100.20",
      details: { path: "" },
    });

    app.test.clock.advance(MINUTE_MS);
    const resumed = await content(token, undefined, { headers: { range: "bytes=10-" } });
    expect(resumed.statusCode).toBe(206);
    expect(resumed.body).toBe("abcdefghij");
    expect(resumed.headers["content-range"]).toBe(`bytes 10-19/${sharedContent.report.length}`);
    expect(counted()).toMatchObject({ downloadCount: 1, lastUsedAt: new Date(app.test.clock.now().getTime() - MINUTE_MS).toISOString() });

    const fromStart = await content(token, undefined, { headers: { range: "bytes=0-9" } });
    expect(fromStart.statusCode).toBe(206);
    expect(fromStart.headers["content-range"]).toBe(`bytes 0-9/${sharedContent.report.length}`);
    expect(counted()).toMatchObject({ downloadCount: 2, lastUsedAt: app.test.clock.now().toISOString() });

    expectProblem(await content(token, undefined, { headers: { range: "bytes=100-" } }), 416, problemTypes.rangeNotSatisfiable);
    const head = await app.test.app.inject({ method: "HEAD", url: `/api/v1/public/share-links/${token}/content`, headers: viaProxy });
    expect(head.statusCode).toBe(200);
    expect(counted().downloadCount).toBe(2);
    expect(app.test.audited("share-link.downloaded")).toHaveLength(2);
    expect(JSON.stringify(app.test.audited())).not.toContain(token);
  });
});

function expectInertDownload(response: LightMyRequestResponse, name: string, body: string): void {
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe(body);
  expect(response.headers["content-type"]).toBe("application/octet-stream");
  expect(response.headers["content-disposition"]).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["content-security-policy"]).toBe(DOWNLOAD_CSP);
  expect(DOWNLOAD_CSP.split("; ")).toEqual(expect.arrayContaining(["default-src 'none'", "sandbox"]));
}

describe("uploaded HTML and SVG (T4)", () => {
  const html = "<!doctype html><script>fetch('/api/v1/session').then((r) => r.text()).then(alert)</script>";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>';

  it("download as inert attachments from the admin's, the user's and the share-link routes", async () => {
    const alice = tusClient(app.test, app.userCookie);
    const admin = tusClient(app.test, app.adminCookie);
    for (const [name, body] of [
      ["page.html", html],
      ["image.svg", svg],
    ] as const) {
      expect((await alice.upload(Buffer.from(body), { name })).statusCode).toBe(204);
      expect((await admin.upload(Buffer.from(body), { folder: "docs", name, resourceId: app.resourceId })).statusCode).toBe(204);
      const fileLink = await app.createLink({ path: `docs/${name}` });
      const folderLink = await app.createLink({ path: "docs" });

      const downloads = [
        await callFilesRoute(app.test, routes.downloadHomeFile, { cookie: app.userCookie, query: { path: name } }),
        await app.asAdmin(routes.downloadResourceFile, { params: app.resourceId, query: { path: `docs/${name}` } }),
        await content(fileLink.token),
        await content(folderLink.token, name),
      ];
      for (const response of downloads) expectInertDownload(response, name, body);
    }
  });
});

describe("headers of the public share API", () => {
  it("keep every answer out of search engines and referrers", async () => {
    const { token } = await app.createLink({ path: "docs", password: linkPassword });
    const cookie = await unlockCookieOf(token);
    const responses = [
      await describeLink(token),
      await entries(token, undefined, { cookie }),
      await entries(token),
      await content(token, "report.pdf", { cookie }),
      await content(token, "../x", { cookie }),
      await unlock(token, "wrong password"),
      await unlock(token, linkPassword),
      await describeLink(newToken()),
      await describeLink("%2e"),
    ];
    for (const response of responses) {
      expect(response.headers["x-robots-tag"]).toBe(SHARE_ROBOTS_TAG);
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    }
    expect(SHARE_ROBOTS_TAG).toBe("noindex, nofollow");
    expect((await app.asAdmin(routes.listShareLinks)).headers["x-robots-tag"]).toBeUndefined();
  });

  it("are on the share page too", async () => {
    const temp = makeTempDir();
    const web = await buildTestApp({ webRoot: writeWebRoot(temp.dir) });
    try {
      for (const url of [`/s/${newToken()}`, "/s/", "/%73/abc"]) {
        const page = await web.app.inject({ method: "GET", url, headers: viaProxy });
        expect(page.statusCode).toBe(200);
        expect(page.headers["content-type"]).toMatch(/^text\/html/);
        expect(page.headers["x-robots-tag"]).toBe(SHARE_ROBOTS_TAG);
        expect(page.headers["referrer-policy"]).toBe("no-referrer");
      }
      expect((await web.app.inject({ method: "GET", url: "/files", headers: viaProxy })).headers["x-robots-tag"]).toBeUndefined();
    } finally {
      await web.close();
      temp.cleanup();
    }
  });
});
