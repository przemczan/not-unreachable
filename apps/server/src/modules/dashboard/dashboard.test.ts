import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dashboardSchema, problemTypes, routes, type Dashboard } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildShareLinksTestApp,
  callFilesRoute,
  createTestInvitation,
  expectProblem,
  makeStorageRoot,
  systemContext,
  type ShareLinksTestApp,
} from "../../test-support/index.ts";
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
    });
  });

  it("refuses a user with 403, and a caller without a session with 401", async () => {
    expectProblem(await callFilesRoute(app.test, routes.getDashboard, { cookie: app.userCookie }), 403, problemTypes.forbidden);
    expectProblem(await callFilesRoute(app.test, routes.getDashboard), 401, problemTypes.signInRequired);
  });
});
