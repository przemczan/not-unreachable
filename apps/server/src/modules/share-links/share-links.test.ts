import { symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  problemTypes,
  routes,
  shareLinkDetailSchema,
  shareLinkSchema,
  shareLinksPageSchema,
  type ShareLink,
} from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildShareLinksTestApp,
  cookieFromSetCookie,
  expectProblem,
  makeFifo,
  setCookiesOf,
  testOrigin,
  testSecrets,
  type ShareLinksTestApp,
} from "../../test-support/index.ts";
import { tableRows, UNKNOWN_ID } from "../../test-support/sessions.ts";
import {
  createSecrets,
  DAY_MS,
  envelopeColumns,
  hashToken,
  MINUTE_MS,
  rotateMasterKey,
  TOKEN_PATTERN,
  type JobDefinition,
  type JobScheduler,
} from "../platform/index.ts";
import { scheduleShareLinkUnlocksPurge, SHARE_LINK_UNLOCKS_PURGE_JOB, tokenAad } from "./index.ts";

let app: ShareLinksTestApp;

beforeEach(async () => {
  app = await buildShareLinksTestApp();
});
afterEach(async () => {
  await app.close();
});

const HOUR_MS = 60 * MINUTE_MS;
const linkPassword = "open sesame 42";

const isoIn = (milliseconds: number): string => new Date(app.test.clock.now().getTime() + milliseconds).toISOString();

const list = async (query: Record<string, string> = {}) => {
  const response = await app.asAdmin(routes.listShareLinks, { query });
  expect(response.statusCode).toBe(200);
  return shareLinksPageSchema.parse(response.json());
};

const change = (id: string, payload: object) => app.asAdmin(routes.changeShareLink, { params: id, payload });

/** The access details of an audit event for a link anyone may open. */
const anyone = { access: "anyone", allowedUserIds: [] } as const;

/** Every secret a link's row holds, which no answer may carry. */
const secretsOf = (id: string): string[] => {
  const row = app.row(id);
  return [row["token_hash"], row["token"], row["password_hash"]].filter((value): value is string => typeof value === "string");
};

const expectNoSecrets = (response: LightMyRequestResponse, id: string): void => {
  for (const secret of secretsOf(id)) expect(response.body).not.toContain(secret);
  expect(response.body).not.toMatch(/tokenHash|token_hash|passwordHash|password_hash|"token"|"password"/);
};

describe("creating a share link", () => {
  it("makes a file link, its kind read from storage, expiring in 7 days by default", async () => {
    const response = await app.asAdmin(routes.createShareLink, { payload: { resourceId: app.resourceId, path: "single.txt" } });
    expect(response.statusCode).toBe(201);
    const { shareLink, link } = shareLinkDetailSchema.parse(response.json());
    expect(shareLink).toEqual<ShareLink>({
      id: shareLink.id,
      resourceId: app.resourceId,
      resourceName: "Files",
      path: "single.txt",
      name: "single.txt",
      kind: "file",
      state: "active",
      hasPassword: false,
      access: "anyone",
      allowedUsers: [],
      expiresAt: isoIn(DEFAULT_SHARE_LINK_EXPIRY_DAYS * DAY_MS),
      noExpiry: false,
      lockedUntil: null,
      locked: false,
      downloadCount: 0,
      lastUsedAt: null,
      createdAt: app.test.clock.now().toISOString(),
      revokedAt: null,
    });
    const token = link.slice(`${testOrigin}/s/`.length);
    expect(link).toBe(`${testOrigin}/s/${token}`);
    expect(token).toMatch(TOKEN_PATTERN);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expectNoSecrets(response, shareLink.id);

    expect(
      app.test.audited("share-link.created").map((event) => [event.actorAccountId, event.targetKind, event.targetId, event.details]),
    ).toEqual([
      [
        app.admin.id,
        "share-link",
        shareLink.id,
        {
          resourceId: app.resourceId,
          path: "single.txt",
          kind: "file",
          hasPassword: false,
          expiresAt: shareLink.expiresAt,
          access: "anyone",
          allowedUserIds: [],
        },
      ],
    ]);
    expect(JSON.stringify(app.test.audited())).not.toContain(token);
  });

  it("makes a folder link, with the path as storage normalised it", async () => {
    const { shareLink } = await app.createLink({ path: "docs//sub/" });
    expect(shareLink).toMatchObject({ kind: "folder", path: "docs/sub", name: "sub" });
  });

  it("takes an expiry time or no expiry, the latter only when asked for", async () => {
    const at = isoIn(3 * HOUR_MS);
    expect((await app.createLink({ path: "single.txt", expiresAt: at })).shareLink).toMatchObject({ expiresAt: at, noExpiry: false });
    expect((await app.createLink({ path: "single.txt", noExpiry: true })).shareLink).toMatchObject({ expiresAt: null, noExpiry: true });
    const create = (payload: object) =>
      app.asAdmin(routes.createShareLink, { payload: { resourceId: app.resourceId, path: "single.txt", ...payload } });
    expectProblem(await create({ noExpiry: false }), 400, problemTypes.validationFailed);
    expectProblem(await create({ noExpiry: true, expiresAt: at }), 400, problemTypes.validationFailed);
    expectProblem(await create({ expiresAt: isoIn(-MINUTE_MS) }), 422, problemTypes.validationFailed);
    expectProblem(await create({ expiresAt: app.test.clock.now().toISOString() }), 422, problemTypes.validationFailed);
  });

  it("stores the token as its SHA-256 and an envelope, and the password as argon2id", async () => {
    const { shareLink, token } = await app.createLink({ path: "single.txt", password: linkPassword });
    expect(shareLink.hasPassword).toBe(true);
    const row = app.row(shareLink.id);
    expect(row["token_hash"]).toBe(hashToken(token));
    expect(String(row["token"])).not.toContain(token);
    expect(testSecrets.decrypt("share-link", tokenAad(shareLink.id), String(row["token"]))).toBe(token);
    expect(String(row["password_hash"])).toMatch(/^\$argon2id\$/);
    expect(String(row["password_hash"])).not.toContain(linkPassword);
    expect(app.test.audited("share-link.created")[0]?.details).toMatchObject({ hasPassword: true });
    expect(JSON.stringify(app.test.audited())).not.toContain(linkPassword);
  });

  it("refuses a short password, the top folder, a missing item, a link or a special file", async () => {
    const create = (payload: object) => app.asAdmin(routes.createShareLink, { payload: { resourceId: app.resourceId, ...payload } });
    expectProblem(await create({ path: "single.txt", password: "short12" }), 400, problemTypes.validationFailed);
    expectProblem(await create({ path: "" }), 400, problemTypes.validationFailed);
    expect(expectProblem(await create({ path: "/" }), 422, problemTypes.pathRefused).reason).toBe("invalid");
    expect(expectProblem(await create({ path: "../single.txt" }), 422, problemTypes.pathRefused).reason).toBe("invalid");
    expectProblem(await create({ path: "nope.txt" }), 404, problemTypes.notFound);
    symlinkSync("/etc", join(app.resourceDir, "etc"));
    expect(expectProblem(await create({ path: "etc" }), 422, problemTypes.pathRefused).reason).toBe("symlink");
    makeFifo(join(app.resourceDir, "pipe"));
    expect(expectProblem(await create({ path: "pipe" }), 422, problemTypes.pathRefused).reason).toBe("special-file");
    expectProblem(await create({ path: "single.txt", resourceId: UNKNOWN_ID }), 404, problemTypes.notFound);
    expect(tableRows(app.test, "share_links")).toEqual([]);
    expect(app.test.audited("share-link.created")).toEqual([]);
  });

  it("is the admin's alone", async () => {
    const payload = { resourceId: app.resourceId, path: "single.txt" };
    expectProblem(await app.asAdmin(routes.createShareLink, { payload, cookie: app.userCookie }), 403, problemTypes.forbidden);
    expectProblem(await app.asPublic(routes.createShareLink, "", { payload }), 401, problemTypes.signInRequired);
    expectProblem(await app.asAdmin(routes.listShareLinks, { cookie: app.userCookie }), 403, problemTypes.forbidden);
  });
});

const states = (page: { shareLinks: ShareLink[] }) => page.shareLinks.map((link) => [link.id, link.state]);

describe("the Share links screen", () => {
  it("lists newest first, a page at a time", async () => {
    const ids: string[] = [];
    for (let link = 0; link < 5; link += 1) {
      ids.push((await app.createLink({ path: "single.txt" })).shareLink.id);
      app.test.clock.advance(1000);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list({ limit: "2", ...(cursor === null ? {} : { cursor }) });
      seen.push(...page.shareLinks.map((link) => link.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(seen).toEqual(ids.toReversed());
    expect(pages).toBe(3);
    expectProblem(await app.asAdmin(routes.listShareLinks, { query: { cursor: "bm9wZQ" } }), 400, problemTypes.badRequest);
    expectProblem(await app.asAdmin(routes.listShareLinks, { query: { limit: "201" } }), 400, problemTypes.validationFailed);
  });

  it("filters active, expired and revoked links, with the flags no expiry and locked", async () => {
    const createApart = async (request: Parameters<ShareLinksTestApp["createLink"]>[0]) => {
      app.test.clock.advance(1000);
      return (await app.createLink(request)).shareLink;
    };
    const active = await createApart({ path: "single.txt", noExpiry: true });
    const expiring = await createApart({ path: "docs", expiresAt: isoIn(HOUR_MS) });
    const revoked = await createApart({ path: "docs/report.pdf" });
    const locked = await createApart({ path: "single.txt", password: linkPassword });
    expect((await app.asAdmin(routes.revokeShareLink, { params: revoked.id })).statusCode).toBe(200);
    app.test.clock.advance(HOUR_MS);
    const lockedUntil = isoIn(30 * MINUTE_MS);
    app.test.database.sqlite.prepare("UPDATE share_links SET locked_until = ? WHERE id = ?").run(lockedUntil, locked.id);

    expect(states(await list())).toEqual([
      [locked.id, "active"],
      [revoked.id, "revoked"],
      [expiring.id, "expired"],
      [active.id, "active"],
    ]);
    expect(states(await list({ state: "active" }))).toEqual([
      [locked.id, "active"],
      [active.id, "active"],
    ]);
    expect(states(await list({ state: "expired" }))).toEqual([[expiring.id, "expired"]]);
    expect(states(await list({ state: "revoked" }))).toEqual([[revoked.id, "revoked"]]);

    const byId = new Map((await list()).shareLinks.map((link) => [link.id, link]));
    expect(byId.get(active.id)).toMatchObject({ noExpiry: true, expiresAt: null, locked: false, lockedUntil: null });
    expect(byId.get(locked.id)).toMatchObject({ noExpiry: false, locked: true, lockedUntil });
    expect(byId.get(revoked.id)?.revokedAt).not.toBeNull();

    app.test.clock.advance(30 * MINUTE_MS);
    expect((await list({ state: "active" })).shareLinks[0]).toMatchObject({ id: locked.id, locked: false, lockedUntil: null });
  });

  it("gets one link with its whole URL, built from PUBLIC_ORIGIN whatever the request's host", async () => {
    const created = await app.createLink({ path: "single.txt", password: linkPassword });
    const response = await app.asAdmin(routes.getShareLink, {
      params: created.shareLink.id,
      headers: { "x-forwarded-host": "evil.example", host: "evil.example" },
    });
    expect(response.statusCode).toBe(200);
    expect(shareLinkDetailSchema.parse(response.json())).toEqual({
      shareLink: created.shareLink,
      link: `${testOrigin}/s/${created.token}`,
    });
    expectNoSecrets(response, created.shareLink.id);
    expectProblem(await app.asAdmin(routes.getShareLink, { params: UNKNOWN_ID }), 404, problemTypes.notFound);
    expectNoSecrets(await app.asAdmin(routes.listShareLinks), created.shareLink.id);
  });
});

describe("changing a share link", () => {
  it("changes the expiry, and audits it", async () => {
    const { shareLink } = await app.createLink({ path: "single.txt" });
    const later = isoIn(30 * DAY_MS);
    const response = await change(shareLink.id, { expiresAt: later });
    expect(response.statusCode).toBe(200);
    expect(shareLinkDetailSchema.parse(response.json()).shareLink).toMatchObject({ expiresAt: later, noExpiry: false, hasPassword: false });
    app.test.clock.advance(1000);
    const none = shareLinkDetailSchema.parse((await change(shareLink.id, { noExpiry: true })).json()).shareLink;
    expect(none).toMatchObject({ expiresAt: null, noExpiry: true });
    expect(app.test.audited("share-link.changed").map((event) => event.details)).toEqual([
      { fields: ["expiry"], hasPassword: false, expiresAt: null, unlocksDeleted: 0, ...anyone },
      { fields: ["expiry"], hasPassword: false, expiresAt: later, unlocksDeleted: 0, ...anyone },
    ]);
    expectProblem(await change(shareLink.id, {}), 400, problemTypes.validationFailed);
    expectProblem(await change(shareLink.id, { expiresAt: isoIn(-1000) }), 422, problemTypes.validationFailed);
    expectProblem(await change(shareLink.id, { password: "short" }), 400, problemTypes.validationFailed);
    expectProblem(await change(UNKNOWN_ID, { noExpiry: true }), 404, problemTypes.notFound);
  });

  it("sets and removes the password, deleting every unlock each time", async () => {
    const { shareLink, token } = await app.createLink({ path: "single.txt", password: linkPassword });
    const unlock = async (password: string) => {
      const response = await app.asPublic(routes.unlockShareLink, token, { payload: { password } });
      expect(response.statusCode).toBe(204);
      return cookieFromSetCookie(setCookiesOf(response)[0] ?? "");
    };
    const content = (cookie: string) => app.asPublic(routes.downloadShareLinkContent, token, { cookie });
    const first = await unlock(linkPassword);
    await unlock(linkPassword);
    expect((await content(first)).statusCode).toBe(200);

    const newPassword = "a whole new password";
    const changed = await change(shareLink.id, { password: newPassword });
    expect(changed.statusCode).toBe(200);
    expectNoSecrets(changed, shareLink.id);
    expect(tableRows(app.test, "share_link_unlocks")).toEqual([]);
    expectProblem(await content(first), 401, problemTypes.shareLinkPasswordRequired);
    expectProblem(
      await app.asPublic(routes.unlockShareLink, token, { payload: { password: linkPassword } }),
      401,
      problemTypes.shareLinkPasswordWrong,
    );
    const second = await unlock(newPassword);
    expect((await content(second)).statusCode).toBe(200);

    app.test.clock.advance(1000);
    const removed = shareLinkDetailSchema.parse((await change(shareLink.id, { password: null })).json()).shareLink;
    expect(removed.hasPassword).toBe(false);
    expect(app.row(shareLink.id)["password_hash"]).toBeNull();
    expect(tableRows(app.test, "share_link_unlocks")).toEqual([]);
    expect((await content("")).statusCode).toBe(200);

    expect(app.test.audited("share-link.changed").map((event) => event.details)).toEqual([
      { fields: ["password"], hasPassword: false, expiresAt: shareLink.expiresAt, unlocksDeleted: 1, ...anyone },
      { fields: ["password"], hasPassword: true, expiresAt: shareLink.expiresAt, unlocksDeleted: 2, ...anyone },
    ]);
    expect(JSON.stringify(app.test.audited())).not.toContain(newPassword);
  });
});

const changed = async (id: string, payload: object): Promise<ShareLink> => {
  const response = await change(id, payload);
  expect(response.statusCode).toBe(200);
  return shareLinkDetailSchema.parse(response.json()).shareLink;
};
const allowedOf = (link: ShareLink) => link.allowedUsers.map((user) => user.username);

describe("a link's access", () => {
  it("is anyone by default, or signed-in users, or selected users listed by username, each once", async () => {
    const zed = (await app.addUser("zed")).account;
    const open = (await app.createLink({ path: "single.txt" })).shareLink;
    const signedIn = (await app.createLink({ path: "docs", access: "signed-in" })).shareLink;
    const selected = (
      await app.createLink({ path: "docs/report.pdf", access: "selected-users", allowedUserIds: [zed.id, app.user.id, zed.id] })
    ).shareLink;
    expect(open).toMatchObject({ access: "anyone", allowedUsers: [] });
    expect(signedIn).toMatchObject({ access: "signed-in", allowedUsers: [] });
    expect(selected).toMatchObject({
      access: "selected-users",
      allowedUsers: [
        { id: app.user.id, username: "alice", displayName: app.user.displayName },
        { id: zed.id, username: "zed", displayName: zed.displayName },
      ],
    });

    const byId = new Map((await list()).shareLinks.map((link) => [link.id, link]));
    expect(byId.get(open.id)).toEqual(open);
    expect(byId.get(signedIn.id)).toEqual(signedIn);
    expect(byId.get(selected.id)).toEqual(selected);
    expect(shareLinkDetailSchema.parse((await app.asAdmin(routes.getShareLink, { params: selected.id })).json()).shareLink).toEqual(
      selected,
    );

    expect(app.test.audited("share-link.created").map((event) => [event.targetId, event.details])).toEqual(
      expect.arrayContaining([
        [open.id, expect.objectContaining(anyone)],
        [signedIn.id, expect.objectContaining({ access: "signed-in", allowedUserIds: [] })],
        [selected.id, expect.objectContaining({ access: "selected-users", allowedUserIds: [app.user.id, zed.id] })],
      ]),
    );
  });

  it("refuses users without Selected users, none, an unknown account or the admin's", async () => {
    const create = (payload: object) =>
      app.asAdmin(routes.createShareLink, { payload: { resourceId: app.resourceId, path: "single.txt", ...payload } });
    expectProblem(await create({ access: "selected-users" }), 400, problemTypes.validationFailed);
    expectProblem(await create({ access: "selected-users", allowedUserIds: [] }), 400, problemTypes.validationFailed);
    expectProblem(await create({ allowedUserIds: [app.user.id] }), 400, problemTypes.validationFailed);
    expectProblem(await create({ access: "anyone", allowedUserIds: [app.user.id] }), 400, problemTypes.validationFailed);
    expectProblem(await create({ access: "signed-in", allowedUserIds: [app.user.id] }), 400, problemTypes.validationFailed);
    expectProblem(await create({ access: "nobody" }), 400, problemTypes.validationFailed);
    expectProblem(await create({ access: "selected-users", allowedUserIds: [UNKNOWN_ID] }), 422, problemTypes.validationFailed);
    expectProblem(await create({ access: "selected-users", allowedUserIds: [app.admin.id] }), 422, problemTypes.validationFailed);
    expectProblem(
      await create({ access: "selected-users", allowedUserIds: [app.user.id, app.admin.id] }),
      422,
      problemTypes.validationFailed,
    );
    expect(tableRows(app.test, "share_links")).toEqual([]);
    expect(tableRows(app.test, "share_link_users")).toEqual([]);
    expect(app.test.audited("share-link.created")).toEqual([]);

    const { shareLink } = await app.createLink({ path: "single.txt" });
    expectProblem(await change(shareLink.id, { allowedUserIds: [app.user.id] }), 400, problemTypes.validationFailed);
    expectProblem(await change(shareLink.id, { access: "selected-users" }), 400, problemTypes.validationFailed);
    expectProblem(
      await change(shareLink.id, { access: "selected-users", allowedUserIds: [app.admin.id] }),
      422,
      problemTypes.validationFailed,
    );
    expectProblem(
      await change(shareLink.id, { access: "selected-users", allowedUserIds: [UNKNOWN_ID] }),
      422,
      problemTypes.validationFailed,
    );
    expect(app.row(shareLink.id)["access"]).toBe("anyone");
    expect(app.test.audited("share-link.changed")).toEqual([]);
  });

  it("changes, the new list replacing the old one, and keeps the unlocks", async () => {
    const zed = (await app.addUser("zed")).account;
    const { shareLink, token } = await app.createLink({
      path: "single.txt",
      password: linkPassword,
      access: "selected-users",
      allowedUserIds: [app.user.id],
    });
    const unlocked = await app.asPublic(routes.unlockShareLink, token, { cookie: app.userCookie, payload: { password: linkPassword } });
    expect(unlocked.statusCode).toBe(204);

    expect(allowedOf(await changed(shareLink.id, { access: "selected-users", allowedUserIds: [zed.id, app.user.id] }))).toEqual([
      "alice",
      "zed",
    ]);
    app.test.clock.advance(1000);
    expect(allowedOf(await changed(shareLink.id, { access: "selected-users", allowedUserIds: [zed.id] }))).toEqual(["zed"]);
    app.test.clock.advance(1000);
    expect(allowedOf(await changed(shareLink.id, { access: "selected-users", allowedUserIds: [zed.id] }))).toEqual(["zed"]);
    app.test.clock.advance(1000);
    expect(await changed(shareLink.id, { access: "signed-in" })).toMatchObject({ access: "signed-in", allowedUsers: [] });
    expect(tableRows(app.test, "share_link_users")).toEqual([]);
    app.test.clock.advance(1000);
    expect(await changed(shareLink.id, { noExpiry: true })).toMatchObject({ access: "signed-in", noExpiry: true });
    expect(tableRows(app.test, "share_link_unlocks")).toHaveLength(1);

    const common = { hasPassword: true, unlocksDeleted: 0 };
    expect(app.test.audited("share-link.changed").map((event) => event.details)).toEqual([
      { ...common, fields: ["expiry"], expiresAt: null, access: "signed-in", allowedUserIds: [] },
      { ...common, fields: ["access"], expiresAt: shareLink.expiresAt, access: "signed-in", allowedUserIds: [] },
      { ...common, fields: [], expiresAt: shareLink.expiresAt, access: "selected-users", allowedUserIds: [zed.id] },
      { ...common, fields: ["access"], expiresAt: shareLink.expiresAt, access: "selected-users", allowedUserIds: [zed.id] },
      { ...common, fields: ["access"], expiresAt: shareLink.expiresAt, access: "selected-users", allowedUserIds: [app.user.id, zed.id] },
    ]);
  });

  it("loses a removed user from every list, and a list left empty stays Selected users", async () => {
    const bob = await app.addUser("bob");
    const onlyBob = await app.createLink({ path: "single.txt", access: "selected-users", allowedUserIds: [bob.account.id] });
    const both = await app.createLink({ path: "docs", access: "selected-users", allowedUserIds: [bob.account.id, app.user.id] });
    expect((await app.asPublic(routes.getPublicShareLink, onlyBob.token, { cookie: bob.cookie })).statusCode).toBe(200);

    const removed = await app.asAdmin(routes.removeUser, { params: bob.account.id, payload: { homeFolder: "keep" } });
    expect(removed.statusCode).toBe(204);
    const byId = new Map((await list()).shareLinks.map((link) => [link.id, link]));
    expect(byId.get(onlyBob.shareLink.id)).toMatchObject({ access: "selected-users", allowedUsers: [] });
    expect(byId.get(both.shareLink.id)).toMatchObject({ access: "selected-users", allowedUsers: [{ username: "alice" }] });

    expectProblem(
      await app.asPublic(routes.getPublicShareLink, onlyBob.token, { cookie: app.userCookie }),
      403,
      problemTypes.shareLinkNotAllowed,
    );
    expect((await app.asPublic(routes.getPublicShareLink, onlyBob.token, { cookie: app.adminCookie })).statusCode).toBe(200);
  });
});

describe("revoking a share link", () => {
  it("revokes once, audits once, and can't be changed after", async () => {
    const { shareLink, token } = await app.createLink({ path: "single.txt", password: linkPassword });
    expect((await app.asPublic(routes.unlockShareLink, token, { payload: { password: linkPassword } })).statusCode).toBe(204);
    const response = await app.asAdmin(routes.revokeShareLink, { params: shareLink.id });
    expect(response.statusCode).toBe(200);
    const revoked = shareLinkSchema.parse(response.json());
    expect(revoked).toMatchObject({ state: "revoked", revokedAt: app.test.clock.now().toISOString() });
    expectNoSecrets(response, shareLink.id);
    expect(tableRows(app.test, "share_link_unlocks")).toEqual([]);

    app.test.clock.advance(1000);
    expect(shareLinkSchema.parse((await app.asAdmin(routes.revokeShareLink, { params: shareLink.id })).json()).revokedAt).toBe(
      revoked.revokedAt,
    );
    expect(app.test.audited("share-link.revoked").map((event) => [event.targetId, event.actorAccountId, event.details])).toEqual([
      [shareLink.id, app.admin.id, {}],
    ]);
    expectProblem(await change(shareLink.id, { noExpiry: true }), 409, problemTypes.shareLinkRevoked);
    expectProblem(await app.asAdmin(routes.revokeShareLink, { params: UNKNOWN_ID }), 404, problemTypes.notFound);
  });
});

describe("share-link tokens", () => {
  it("are re-encrypted by rotate-key", async () => {
    const { shareLink, token } = await app.createLink({ path: "single.txt" });
    const newKey = Buffer.alloc(32, 9);
    const rotated = rotateMasterKey({ database: app.test.database, oldKey: Buffer.alloc(32, 7), newKey, columns: envelopeColumns });
    expect(rotated).toContainEqual({ table: "share_links", column: "token", reencrypted: 1 });
    expect(createSecrets(newKey).decrypt("share-link", tokenAad(shareLink.id), String(app.row(shareLink.id)["token"]))).toBe(token);
  });

  it("never reach the log, on the API or on the share page", async () => {
    const { token } = await app.createLink({ path: "docs" });
    const unknown = "A".repeat(43);
    for (const value of [token, unknown]) {
      await app.asPublic(routes.getPublicShareLink, value);
      await app.asPublic(routes.listShareLinkEntries, value, { query: { path: "sub" } });
      await app.asPublic(routes.downloadShareLinkContent, value, { query: { path: "report.pdf" } });
      await app.asPublic(routes.unlockShareLink, value, { payload: { password: "whatever" } });
      await app.test.app.inject({ method: "GET", url: `/s/${value}`, headers: { "x-forwarded-proto": "https" } });
      await app.test.app.inject({ method: "GET", url: `/%73/${value}?x=1`, headers: { "x-forwarded-proto": "https" } });
    }
    const logs = JSON.stringify(app.test.logs());
    expect(logs).toContain("/api/v1/public/share-links/<redacted>/entries");
    expect(logs).toContain("/s/<redacted>");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(unknown);
  });
});

describe("the unlocks purge", () => {
  it("runs daily and removes only the expired unlocks", async () => {
    const registered: JobDefinition[] = [];
    const jobs: JobScheduler = { register: (job) => registered.push(job), start: () => undefined, stop: () => undefined };
    scheduleShareLinkUnlocksPurge(jobs, app.test.services.shareLinks);
    expect(registered).toMatchObject([{ name: SHARE_LINK_UNLOCKS_PURGE_JOB, intervalMs: DAY_MS }]);

    const { token } = await app.createLink({ path: "single.txt", password: linkPassword });
    const unlock = () => app.asPublic(routes.unlockShareLink, token, { payload: { password: linkPassword } });
    expect((await unlock()).statusCode).toBe(204);
    app.test.clock.advance(6 * HOUR_MS);
    expect((await unlock()).statusCode).toBe(204);
    app.test.clock.advance(7 * HOUR_MS);
    await registered[0]?.run();
    expect(tableRows(app.test, "share_link_unlocks").map((row) => row["expires_at"])).toEqual([isoIn(-7 * HOUR_MS + 12 * HOUR_MS)]);
  });
});
