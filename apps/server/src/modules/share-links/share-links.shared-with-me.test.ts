import { problemTypes, routes, sharedWithMePageSchema, type SharedWithMeLink, type SharedWithMePage } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildShareLinksTestApp, callFilesRoute, expectProblem, type ShareLinksTestApp } from "../../test-support/index.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { MINUTE_MS } from "../platform/index.ts";

let app: ShareLinksTestApp;

beforeEach(async () => {
  app = await buildShareLinksTestApp();
});
afterEach(async () => {
  await app.close();
});

const HOUR_MS = 60 * MINUTE_MS;

/** Calls Shared with me as this account, in a session of its own (so a test may move the clock far ahead). */
const sharedWith = (account: AccountRecord, query: Record<string, string> = {}) =>
  callFilesRoute(app.test, routes.listSharedWithMe, { cookie: app.test.startSession(account), query });

const pageFor = async (account: AccountRecord, query: Record<string, string> = {}): Promise<SharedWithMePage> => {
  const response = await sharedWith(account, query);
  expect(response.statusCode).toBe(200);
  return sharedWithMePageSchema.parse(response.json());
};

const idsFor = async (account: AccountRecord): Promise<string[]> => (await pageFor(account)).shareLinks.map((link) => link.id);

/** Creates a link, then moves the clock on, so each link is newer than the one before. */
const createLink = async (request: Parameters<ShareLinksTestApp["createLink"]>[0]) => {
  const created = await app.createLink(request);
  app.test.clock.advance(1000);
  return created;
};

describe("Shared with me", () => {
  it("lists every signed-in users link for every user, and a selected-users link only for the users on its list", async () => {
    const bob = (await app.addUser("bob")).account;
    const forEveryone = await createLink({ path: "docs", access: "signed-in" });
    const forAlice = await createLink({ path: "single.txt", access: "selected-users", allowedUserIds: [app.user.id] });
    const forBob = await createLink({ path: "docs/report.pdf", access: "selected-users", allowedUserIds: [bob.id] });
    await createLink({ path: "docs/sub", access: "anyone" });

    expect(await idsFor(app.user)).toEqual([forAlice.shareLink.id, forEveryone.shareLink.id]);
    expect(await idsFor(bob)).toEqual([forBob.shareLink.id, forEveryone.shareLink.id]);
  });

  it("shows each link's name, kind, expiry, password and URL, and never its resource, path or allowed users", async () => {
    const withPassword = await createLink({
      path: "docs/report.pdf",
      access: "selected-users",
      allowedUserIds: [app.user.id],
      password: "open sesame 42",
    });
    const noExpiry = await createLink({ path: "docs/sub", access: "signed-in", noExpiry: true });

    const response = await sharedWith(app.user);
    expect(sharedWithMePageSchema.parse(response.json())).toEqual<SharedWithMePage>({
      shareLinks: [
        { id: noExpiry.shareLink.id, name: "sub", kind: "folder", expiresAt: null, hasPassword: false, link: noExpiry.link },
        {
          id: withPassword.shareLink.id,
          name: "report.pdf",
          kind: "file",
          expiresAt: withPassword.shareLink.expiresAt,
          hasPassword: true,
          link: withPassword.link,
        } satisfies SharedWithMeLink,
      ],
      nextCursor: null,
    });
    expect(response.body).not.toContain(app.resourceId);
    expect(response.body).not.toContain("docs/");
    expect(response.body).not.toContain(app.user.id);
    expect(app.test.audited("share-link.created")).toHaveLength(2);
  });

  it("leaves out revoked and expired links, and keeps a locked one", async () => {
    const revoked = await createLink({ path: "docs", access: "signed-in" });
    expect((await app.asAdmin(routes.revokeShareLink, { params: revoked.shareLink.id })).statusCode).toBe(200);
    const expiring = await createLink({
      path: "single.txt",
      access: "signed-in",
      expiresAt: new Date(app.test.clock.now().getTime() + HOUR_MS).toISOString(),
    });
    const lasting = await createLink({ path: "docs/sub", access: "signed-in", noExpiry: true });
    const lockedUntil = new Date(app.test.clock.now().getTime() + 3 * HOUR_MS).toISOString();
    app.test.database.sqlite.prepare("UPDATE share_links SET locked_until = ? WHERE id = ?").run(lockedUntil, lasting.shareLink.id);
    app.test.clock.advance(HOUR_MS / 2);
    expect(await idsFor(app.user)).toEqual([lasting.shareLink.id, expiring.shareLink.id]);

    app.test.clock.advance(HOUR_MS);
    expect(await idsFor(app.user)).toEqual([lasting.shareLink.id]);
  });

  it("pages newest first", async () => {
    const created: string[] = [];
    for (const path of ["docs", "single.txt", "docs/sub", "docs/report.pdf", "docs/sub/nested.txt"]) {
      created.unshift((await createLink({ path, access: "signed-in" })).shareLink.id);
    }
    const first = await pageFor(app.user, { limit: "2" });
    expect(first.shareLinks.map((link) => link.id)).toEqual(created.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await pageFor(app.user, { limit: "2", cursor: first.nextCursor ?? "" });
    expect(second.shareLinks.map((link) => link.id)).toEqual(created.slice(2, 4));
    const third = await pageFor(app.user, { limit: "2", cursor: second.nextCursor ?? "" });
    expect(third).toEqual({ shareLinks: [expect.objectContaining({ id: created[4] })], nextCursor: null });
  });

  it("answers an empty page when nothing is shared with the user", async () => {
    await createLink({ path: "docs", access: "anyone" });
    expect(await pageFor(app.user)).toEqual({ shareLinks: [], nextCursor: null });
  });

  it("refuses a bad cursor or limit", async () => {
    expectProblem(await sharedWith(app.user, { cursor: "bm9wZQ" }), 400, problemTypes.badRequest);
    expectProblem(await sharedWith(app.user, { limit: "201" }), 400, problemTypes.validationFailed);
  });

  it("answers only users: 403 for the admin, 401 when signed out", async () => {
    expectProblem(await sharedWith(app.admin), 403, problemTypes.forbidden);
    expectProblem(await callFilesRoute(app.test, routes.listSharedWithMe), 401, problemTypes.signInRequired);
  });
});
