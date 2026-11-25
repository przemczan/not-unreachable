import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  problemTypes,
  routes,
  SSO_SIGN_IN_COMPLETE_PATH,
  SSO_SIGN_IN_FAILED_PATH,
  type SsoProvider,
  type User,
  type Users,
} from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTestProvider,
  buildSsoTestApp,
  createTestInvitation,
  expectProblem,
  followToCallback,
  linkTestIdentity,
  makeStorageRoot,
  postAccept,
  sameOriginWrite,
  setTestHomeRoot,
  startSsoSignIn,
  type FakeIdentity,
  type SsoTestRig,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { MINUTE_MS } from "../platform/index.ts";
import { openSignInGate } from "../sign-in/index.ts";

let rig: SsoTestRig;
let test: TestApp;
let homes: ReturnType<typeof makeStorageRoot>;
let provider: SsoProvider;
let adminCookie: string;
let admin: AccountRecord;
let bob: AccountRecord;
let bobLink: string;

beforeEach(async () => {
  rig = await buildSsoTestApp({ signInGate: openSignInGate });
  test = rig.test;
  homes = makeStorageRoot();
  await setTestHomeRoot(test, homes.dir);
  provider = await addTestProvider(test);
  admin = await test.createAdmin();
  adminCookie = await test.signIn("admin");
  bob = test.createUser({ username: "bob", email: "bob@example.com", displayName: "Bob" });
  bobLink = linkTestIdentity(test, bob.id, provider, "bob-sub", "bob@idp.test");
  await test.services.resources.createHome("bob");
});
afterEach(async () => {
  await rig.close();
  homes.cleanup();
});

async function ssoSignIn(identity: FakeIdentity): Promise<LightMyRequestResponse> {
  const { url, flowCookie } = await startSsoSignIn(test, provider.id);
  return followToCallback(test, rig.idp.authorize(url, identity), flowCookie);
}

const change = (payload: object) => callRoute(test, routes.changeUser, { cookie: adminCookie, params: bob.id, payload });
const remove = (homeFolder: "keep" | "delete", cookie = adminCookie) =>
  callRoute(test, routes.removeUser, { cookie, params: bob.id, payload: { homeFolder } });

describe("Users (the admin's tab)", () => {
  it("lists the users oldest first, with their linked sign-ins and the default quota, never the admin", async () => {
    test.clock.advance(1000);
    test.createUser({ username: "carol", email: "carol@example.com" });
    const listed = (await callRoute(test, routes.listUsers, { cookie: adminCookie })).json<Users>();
    expect(listed.defaultQuotaBytes).toBe(10 * 1024 ** 3);
    expect(listed.users.map((user) => user.username)).toEqual(["bob", "carol"]);
    expect(listed.users[0]).toEqual({
      id: bob.id,
      username: "bob",
      email: "bob@example.com",
      displayName: "Bob",
      status: "active",
      quotaBytes: null,
      linkedSignIns: [
        {
          id: bobLink,
          providerId: provider.id,
          providerName: "Test IdP",
          providerKind: "oidc",
          email: "bob@idp.test",
          createdAt: bob.createdAt,
          lastUsedAt: null,
        },
      ],
      createdAt: bob.createdAt,
      disabledAt: null,
    });
    expect((await callRoute(test, routes.getUser, { cookie: adminCookie, params: bob.id })).json<User>()).toEqual(listed.users[0]);
  });

  it("answers 404 for the admin's own account and unknown ids on every user route", async () => {
    const asked = [
      callRoute(test, routes.getUser, { cookie: adminCookie, params: admin.id }),
      callRoute(test, routes.changeUser, { cookie: adminCookie, params: admin.id, payload: { status: "disabled" } }),
      callRoute(test, routes.removeUser, { cookie: adminCookie, params: admin.id, payload: {} }),
      callRoute(test, routes.createRelinkLink, { cookie: adminCookie, params: admin.id }),
      callRoute(test, routes.getUser, { cookie: adminCookie }),
      callRoute(test, routes.removeUserLinkedSignIn, { cookie: adminCookie }),
    ];
    for (const answer of await Promise.all(asked)) expectProblem(answer, 404, problemTypes.notFound);
    expect(test.services.accounts.findById(admin.id)?.status).toBe("active");
  });

  it("disabling signs the user out everywhere and stops their sign-in; enabling lets them in again", async () => {
    const bobCookie = test.startSession(bob);
    const disabled = await change({ status: "disabled" });
    expect(disabled.json<User>()).toMatchObject({ status: "disabled", disabledAt: test.clock.now().toISOString() });
    expect((await callRoute(test, routes.getSession, { cookie: bobCookie })).statusCode).toBe(401);
    expect((await ssoSignIn({ sub: "bob-sub" })).headers.location).toBe(SSO_SIGN_IN_FAILED_PATH);
    expect(test.audited("account.disabled").map((event) => [event.targetId, event.details])).toEqual([[bob.id, { revokedSessions: 1 }]]);
    expect(test.audited("session.revoked")[0]?.details).toMatchObject({ reason: "account-disabled" });

    expect((await change({ status: "active" })).json<User>()).toMatchObject({ status: "active", disabledAt: null });
    expect((await ssoSignIn({ sub: "bob-sub" })).headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
    expect(test.audited("account.enabled").map((event) => [event.targetId, event.details])).toEqual([[bob.id, {}]]);
    // The same status again changes and records nothing.
    await change({ status: "active" });
    expect(test.audited("account.enabled")).toHaveLength(1);
  });

  it("sets a user's own quota and the default one", async () => {
    expect((await change({ quotaBytes: 5000 })).json<User>().quotaBytes).toBe(5000);
    expect((await change({ quotaBytes: null })).json<User>().quotaBytes).toBeNull();
    expect(test.audited("account.changed").map((event) => event.details)).toEqual([{ fields: ["quota"] }, { fields: ["quota"] }]);
    expect((await change({})).json()).toMatchObject({ status: 400, type: problemTypes.validationFailed });

    const set = await callRoute(test, routes.setDefaultQuota, { cookie: adminCookie, payload: { defaultQuotaBytes: 1024 } });
    expect(set.json()).toEqual({ defaultQuotaBytes: 1024 });
    expect((await callRoute(test, routes.listUsers, { cookie: adminCookie })).json<Users>().defaultQuotaBytes).toBe(1024);
    expect(test.audited("settings.changed").map((event) => event.details)).toEqual([{ keys: ["defaultQuotaBytes"] }]);
  });

  it("removes a user's linked sign-in, but never their last one", async () => {
    const unlink = (link: string) =>
      test.app.inject({
        method: "DELETE",
        url: routes.removeUserLinkedSignIn.path.replace(":id", bob.id).replace(":link", link),
        headers: { ...sameOriginWrite, cookie: adminCookie },
      });
    expectProblem(await unlink(bobLink), 409, problemTypes.lastSignInMethod);
    const second = linkTestIdentity(test, bob.id, provider, "bob-other");
    expect((await unlink(second)).statusCode).toBe(204);
    expect(tableRows(test, "linked_sign_ins").map((row) => row["id"])).toEqual([bobLink]);
    expect(test.audited("linked-sign-in.removed").map((event) => [event.targetId, event.details["linkedSignInId"]])).toEqual([
      [bob.id, second],
    ]);
  });
});

describe("Removing a user", () => {
  it("needs a recent sign-in", async () => {
    test.clock.advance(11 * MINUTE_MS);
    expectProblem(await remove("keep"), 403, problemTypes.recentSignInRequired);
    expect(test.services.accounts.findById(bob.id)).toBeDefined();
  });

  it("keeps the home and reserves the name while its folder is there", async () => {
    writeFileSync(join(homes.dir, "bob", "notes.txt"), "mine");
    const bobCookie = test.startSession(bob);
    await test.services.users.createRelinkLink(bob.id, { actor: { kind: "system" }, origin: { ip: null, userAgent: null } });
    expect((await remove("keep")).statusCode).toBe(204);

    expect(test.services.accounts.findById(bob.id)).toBeUndefined();
    expect(existsSync(join(homes.dir, "bob", "notes.txt"))).toBe(true);
    expect(tableRows(test, "reserved_usernames").map((row) => row["username"])).toEqual(["bob"]);
    expect(tableRows(test, "linked_sign_ins")).toEqual([]);
    expect(tableRows(test, "invitations")).toEqual([]);
    expect((await callRoute(test, routes.getSession, { cookie: bobCookie })).statusCode).toBe(401);
    expect((await ssoSignIn({ sub: "bob-sub" })).headers.location).toBe(SSO_SIGN_IN_FAILED_PATH);
    expect(test.audited("account.deleted").map((event) => [event.targetId, event.details])).toEqual([
      [bob.id, { username: "bob", homeFolder: "keep" }],
    ]);
    expect(test.audited("linked-sign-in.removed")).toHaveLength(1);
    expect(test.audited("session.revoked").map((event) => event.details["reason"])).toContain("account-removed");

    const invitation = await createTestInvitation(test);
    expectProblem(
      await postAccept(test, invitation.token, { providerId: provider.id, username: "bob" }),
      409,
      problemTypes.usernameReserved,
    );
  });

  it("deletes the home with everything in it, which frees the name", async () => {
    writeFileSync(join(homes.dir, "bob", "notes.txt"), "mine");
    expect((await remove("delete")).statusCode).toBe(204);
    expect(existsSync(join(homes.dir, "bob"))).toBe(false);
    expect(tableRows(test, "homes")).toEqual([]);
    expect(tableRows(test, "reserved_usernames")).toEqual([]);
    expect(test.audited("account.deleted").map((event) => event.details)).toEqual([{ username: "bob", homeFolder: "delete" }]);

    const invitation = await createTestInvitation(test);
    expect((await postAccept(test, invitation.token, { providerId: provider.id, username: "bob" })).statusCode).toBe(200);
  });
});
