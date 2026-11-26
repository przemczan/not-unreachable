import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dashboardSchema, problemTypes, RECENT_UPLOADERS_LIMIT, routes, type Dashboard } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildShareLinksTestApp,
  callFilesRoute,
  createTestInvitation,
  expectProblem,
  makeStorageRoot,
  systemContext,
  tusClient,
  type ShareLinksTestApp,
} from "../../test-support/index.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { DAY_MS, MINUTE_MS } from "../platform/index.ts";

const HOUR_MS = 60 * MINUTE_MS;

describe("the admin Dashboard", () => {
  let app: ShareLinksTestApp;
  let extra: ReturnType<typeof makeStorageRoot>;

  beforeEach(async () => {
    app = await buildShareLinksTestApp();
    extra = makeStorageRoot();
  });
  afterEach(async () => {
    await app.close();
    extra.cleanup();
  });

  const isoIn = (milliseconds: number): string => new Date(app.test.clock.now().getTime() + milliseconds).toISOString();

  const read = async (): Promise<Dashboard> => {
    const response = await app.asAdmin(routes.getDashboard);
    expect(response.statusCode).toBe(200);
    return dashboardSchema.parse(response.json());
  };

  it("counts each module's records, as their own screens read them now", async () => {
    // Users: alice (the test app's) and bob active, carol disabled; the admin never counts.
    await app.addUser("bob");
    const carol = await app.addUser("carol");
    app.test.services.accounts.setStatus(carol.account.id, "disabled");

    // Invitations: one pending, one revoked, one expired.
    await createTestInvitation(app.test, { expiresInDays: 30 });
    const revoked = await createTestInvitation(app.test);
    app.test.services.invitations.revoke(revoked.id, systemContext);
    await createTestInvitation(app.test, { expiresInDays: 1 });
    app.test.clock.advance(2 * DAY_MS);

    // Resources: "Files" and "Homes" available, one whose folder went missing unavailable.
    const goneDir = join(extra.dir, "gone");
    mkdirSync(goneDir);
    await app.test.services.resources.add({ kind: "local", name: "Gone", localPath: goneDir }, { kind: "system" });
    rmSync(goneDir, { recursive: true });
    await app.test.services.resources.checkAtStartup();

    // Share links: two active (one locked), one expired, one revoked; 7 downloads in all.
    const active = (await app.createLink({ path: "single.txt", noExpiry: true })).shareLink;
    const expiring = (await app.createLink({ path: "docs", expiresAt: isoIn(HOUR_MS) })).shareLink;
    const revokedLink = (await app.createLink({ path: "docs/report.pdf" })).shareLink;
    const locked = (await app.createLink({ path: "single.txt", password: "open sesame 42" })).shareLink;
    expect((await app.asAdmin(routes.revokeShareLink, { params: revokedLink.id })).statusCode).toBe(200);
    app.test.clock.advance(HOUR_MS);
    const setRow = app.test.database.sqlite.prepare("UPDATE share_links SET locked_until = ?, download_count = ? WHERE id = ?");
    setRow.run(null, 2, active.id);
    setRow.run(null, 4, expiring.id);
    setRow.run(isoIn(HOUR_MS), 1, revokedLink.id);
    setRow.run(isoIn(30 * MINUTE_MS), 0, locked.id);

    expect(await read()).toEqual({
      users: { active: 2, disabled: 1 },
      pendingInvitations: 1,
      resources: { available: 2, unavailable: 1 },
      shareLinks: { active: 2, expired: 1, revoked: 1, locked: 1, downloads: 7 },
      recentUploaders: [],
    });

    // Once the lock is over, the link is no longer counted locked.
    app.test.clock.advance(30 * MINUTE_MS);
    expect((await read()).shareLinks).toEqual({ active: 2, expired: 1, revoked: 1, locked: 0, downloads: 7 });
  });

  it("answers all zeros but the test app's own records when there is nothing else", async () => {
    expect(await read()).toEqual({
      users: { active: 1, disabled: 0 },
      pendingInvitations: 0,
      resources: { available: 2, unavailable: 0 },
      shareLinks: { active: 0, expired: 0, revoked: 0, locked: 0, downloads: 0 },
      recentUploaders: [],
    });
  });

  const upload = async (account: AccountRecord, name: string, target?: { resourceId: string; folder: string }) => {
    const response = await tusClient(app.test, app.test.startSession(account)).upload(Buffer.from(name), {
      name,
      onConflict: "fail",
      ...target,
    });
    expect(response.statusCode).toBe(204);
  };

  describe("Recent uploads", () => {
    it("lists users' own uploads of the last 7 days, last upload newest first, with how many and when", async () => {
      const bob = (await app.addUser("bob")).account;
      const carol = (await app.addUser("carol")).account;
      const dave = (await app.addUser("dave")).account;
      const eve = (await app.addUser("eve")).account;
      const start = app.test.clock.now().getTime();

      await upload(bob, "old.txt");
      app.test.clock.advance(1);
      const daveUploadedAt = app.test.clock.now().toISOString();
      await upload(dave, "edge.txt");
      app.test.clock.advance(DAY_MS);
      await upload(app.user, "first.txt");
      app.test.clock.advance(MINUTE_MS);
      const aliceUploadedAt = app.test.clock.now().toISOString();
      await upload(app.user, "second.txt");

      // Neither the admin's uploads (into carol's home or a resource) nor a failed upload count.
      const homesResourceId = app.test.services.resources.list().homeRoot?.resourceId ?? "";
      await upload(app.admin, "from-admin.txt", { resourceId: homesResourceId, folder: "carol" });
      await upload(app.admin, "shared.txt", { resourceId: app.resourceId, folder: "" });
      app.test.services.audit.record({
        action: "file.uploaded",
        actor: { kind: "account", accountId: carol.id, username: carol.username },
        outcome: "failed",
        details: { resourceId: null, path: "failed.txt", size: 1, onConflict: "fail" },
      });
      // A removed user drops out.
      await upload(eve, "gone.txt");
      app.test.services.accounts.deleteAccount(eve.id);

      // dave's upload is exactly 7 days old, bob's a moment older.
      app.test.clock.advance(start + 7 * DAY_MS + 1 - app.test.clock.now().getTime());
      expect((await read()).recentUploaders).toEqual([
        { userId: app.user.id, username: "alice", displayName: app.user.displayName, uploads: 2, lastUploadAt: aliceUploadedAt },
        { userId: dave.id, username: "dave", displayName: dave.displayName, uploads: 1, lastUploadAt: daveUploadedAt },
      ]);
    });

    it(`lists at most ${RECENT_UPLOADERS_LIMIT} users, dropping the longest ago`, async () => {
      const users = [app.user];
      for (let index = 1; index <= RECENT_UPLOADERS_LIMIT; index += 1) users.push((await app.addUser(`user${index}`)).account);
      for (const user of users) {
        await upload(user, "file.txt");
        app.test.clock.advance(MINUTE_MS);
      }
      const listed = (await read()).recentUploaders.map((uploader) => uploader.username);
      expect(listed).toEqual(
        users
          .slice(1)
          .map((user) => user.username)
          .toReversed(),
      );
    });
  });

  it("refuses a user with 403, and a caller without a session with 401", async () => {
    expectProblem(await callFilesRoute(app.test, routes.getDashboard, { cookie: app.userCookie }), 403, problemTypes.forbidden);
    expectProblem(await callFilesRoute(app.test, routes.getDashboard), 401, problemTypes.signInRequired);
  });
});
