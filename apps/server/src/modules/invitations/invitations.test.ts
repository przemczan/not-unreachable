import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  invitationPath,
  problemTypes,
  relinkPath,
  routes,
  SSO_SIGN_IN_COMPLETE_PATH,
  SSO_SIGN_IN_FAILED_PATH,
  type CreatedInvitation,
  type Invitations,
  type Session,
  type SsoProvider,
} from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTestProvider,
  buildSsoTestApp,
  buildTestApp,
  createTestInvitation,
  createTestRelink,
  expectProblem,
  FAKE_CLIENT_SECRET,
  followToCallback,
  linkTestIdentity,
  makeStorageRoot,
  postAccept,
  postRelinkStart,
  sessionCookieHeader,
  sessionTokenFrom,
  setTestHomeRoot,
  startFakeSmtp,
  startSsoSignIn,
  startTestAccept,
  startTestRelink,
  systemContext,
  testOrigin,
  testSecrets,
  tokenOfLink,
  viaProxy,
  type AcceptBody,
  type FakeGitHubUser,
  type FakeIdentity,
  type SsoTestRig,
  type TestApp,
  type TestInvitation,
} from "../../test-support/index.ts";
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import {
  createSecrets,
  DAY_MS,
  envelopeColumns,
  hashToken,
  MINUTE_MS,
  newToken,
  rotateMasterKey,
  TOKEN_PATTERN,
} from "../platform/index.ts";
import { openSignInGate } from "../sign-in/index.ts";
import { tokenAad } from "./index.ts";

let rig: SsoTestRig;
let test: TestApp;
let homes: ReturnType<typeof makeStorageRoot>;
let provider: SsoProvider;
let adminCookie: string;

beforeEach(async () => {
  // The SSO starts and callbacks here would pass the per-IP sign-in limits, which have tests of their own.
  rig = await buildSsoTestApp({ signInGate: openSignInGate });
  test = rig.test;
  homes = makeStorageRoot();
  await setTestHomeRoot(test, homes.dir);
  provider = await addTestProvider(test);
  await test.createAdmin();
  adminCookie = await test.signIn("admin");
});
afterEach(async () => {
  await rig.close();
  homes.cleanup();
});

const home = (username: string): string => join(homes.dir, username);
const usernames = (): string[] => tableRows(test, "users").map((row) => String(row["username"]));
const sorted = (names: readonly string[]): string[] => names.toSorted((a, b) => a.localeCompare(b));

/** The whole accept: start, sign in at the fake provider as `identity`, and the callback. */
async function accept(token: string, body: Omit<AcceptBody, "providerId">, identity: FakeIdentity): Promise<LightMyRequestResponse> {
  const { url, flowCookie } = await startTestAccept(test, token, { providerId: provider.id, ...body });
  return followToCallback(test, rig.idp.authorize(url, identity), flowCookie);
}

async function relink(token: string, identity: FakeIdentity): Promise<LightMyRequestResponse> {
  const { url, flowCookie } = await startTestRelink(test, token, provider.id);
  return followToCallback(test, rig.idp.authorize(url, identity), flowCookie);
}

async function ssoSignIn(identity: FakeIdentity): Promise<LightMyRequestResponse> {
  const { url, flowCookie } = await startSsoSignIn(test, provider.id);
  return followToCallback(test, rig.idp.authorize(url, identity), flowCookie);
}

const sessionOf = async (cookie: string) => callRoute(test, routes.getSession, { cookie });

const expectSignedInAt = (response: LightMyRequestResponse): string => {
  expect(response.statusCode).toBe(303);
  expect(response.headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
  return sessionCookieHeader(sessionTokenFrom(response));
};

const expectSentBack = (response: LightMyRequestResponse, location: string): void => {
  expect(response.statusCode).toBe(303);
  expect(response.headers.location).toBe(location);
  expect(String(response.headers["set-cookie"])).not.toContain("__Host-nu_session=");
};

/** An answer without its Date, which differs from one request to the next. */
const comparable = (response: LightMyRequestResponse) => {
  const { date: _date, ...headers } = response.headers;
  return { status: response.statusCode, headers, body: response.body };
};

describe("Invitations (the admin's tab)", () => {
  it("makes a 256-bit token, kept only as its hash and an envelope, and never shows or audits it", async () => {
    const created = await callRoute(test, routes.createInvitation, { cookie: adminCookie, payload: { email: "Alice@Example.com" } });
    expect(created.statusCode).toBe(201);
    const body = created.json<CreatedInvitation>();
    const token = tokenOfLink(body.link);
    expect(token).toMatch(TOKEN_PATTERN);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(body.link).toBe(`${testOrigin}/invitation/${token}`);
    expect(body).toMatchObject({
      emailed: false,
      invitation: {
        email: "alice@example.com",
        sendByEmail: false,
        verifyEmail: false,
        state: "pending",
        acceptedAt: null,
        acceptedUsername: null,
        revokedAt: null,
        expiresAt: new Date(test.clock.now().getTime() + 7 * DAY_MS).toISOString(),
      },
    });

    const other = await createTestInvitation(test);
    expect(other.token).not.toBe(token);
    const row = tableRows(test, "invitations").find((found) => found["id"] === body.invitation.id);
    expect(row?.["token_hash"]).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(testSecrets.decrypt("invitation", tokenAad(body.invitation.id), String(row?.["token"]))).toBe(token);

    expect(test.audited("invitation.created").find((event) => event.targetId === body.invitation.id)).toMatchObject({
      targetKind: "invitation",
      details: { expiresAt: body.invitation.expiresAt, hasEmail: true, sendByEmail: false, verifyEmail: false, emailed: false },
    });
    const audit = await callRoute(test, routes.listAuditEvents, { cookie: adminCookie });
    expect(audit.body).not.toContain(token);
  });

  it("refuses to invite while no home root is set", async () => {
    const bare = await buildTestApp();
    try {
      await bare.createAdmin();
      const created = await callRoute(bare, routes.createInvitation, { cookie: await bare.signIn("admin"), payload: {} });
      expectProblem(created, 409, problemTypes.homeRootNotSet);
      expect(tableRows(bare, "invitations")).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it("lists invitations newest first, each in its state", async () => {
    const short = await createTestInvitation(test, { expiresInDays: 1 });
    test.clock.advance(1000);
    const week = await createTestInvitation(test, { email: "week@example.com" });
    test.clock.advance(1000);
    const month = await createTestInvitation(test, { expiresInDays: 30 });
    expect((await callRoute(test, routes.revokeInvitation, { cookie: adminCookie, params: month.id })).statusCode).toBe(204);
    test.clock.advance(2 * DAY_MS);

    const listed = await callRoute(test, routes.listInvitations, { cookie: await test.signIn("admin") });
    expect(listed.json<Invitations>().invitations.map((invitation) => [invitation.id, invitation.state])).toEqual([
      [month.id, "revoked"],
      [week.id, "pending"],
      [short.id, "expired"],
    ]);
  });

  it("copies a pending invitation's link again, and only a pending one's", async () => {
    const invitation = await createTestInvitation(test);
    const copied = await callRoute(test, routes.getInvitationLink, { cookie: adminCookie, params: invitation.id });
    expect(copied.json()).toEqual({ link: invitation.link });

    await callRoute(test, routes.revokeInvitation, { cookie: adminCookie, params: invitation.id });
    expectProblem(
      await callRoute(test, routes.getInvitationLink, { cookie: adminCookie, params: invitation.id }),
      409,
      problemTypes.invitationInvalid,
    );
    expectProblem(await callRoute(test, routes.getInvitationLink, { cookie: adminCookie }), 404, problemTypes.notFound);
  });

  it("revokes a pending invitation once, after which its link is not valid", async () => {
    const invitation = await createTestInvitation(test);
    expect((await callRoute(test, routes.revokeInvitation, { cookie: adminCookie, params: invitation.id })).statusCode).toBe(204);
    expectProblem(
      await callRoute(test, routes.revokeInvitation, { cookie: adminCookie, params: invitation.id }),
      409,
      problemTypes.invitationInvalid,
    );
    expectProblem(await callRoute(test, routes.getInvitation, { params: invitation.token }), 404, problemTypes.invitationInvalid);
    expect(test.audited("invitation.revoked").map((event) => [event.targetId, event.details])).toEqual([[invitation.id, {}]]);
  });

  it("refuses a request whose email options don't fit together", async () => {
    const refused = [
      { sendByEmail: true, verifyEmail: true },
      { verifyEmail: true },
      { email: "a@example.com", sendByEmail: true },
      { email: "a@example.com", sendByEmail: true, verifyEmail: false },
    ];
    for (const payload of refused) {
      const answer = await callRoute(test, routes.createInvitation, { cookie: adminCookie, payload });
      expect(answer.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(tableRows(test, "invitations")).toEqual([]);

    const verified = await callRoute(test, routes.createInvitation, {
      cookie: adminCookie,
      payload: { email: "a@example.com", verifyEmail: true },
    });
    expect(verified.statusCode).toBe(201);
    expect(verified.json<CreatedInvitation>()).toMatchObject({ emailed: false, invitation: { sendByEmail: false, verifyEmail: true } });
  });

  it("refuses to send an invitation by email without SMTP, and makes none", async () => {
    const answer = await callRoute(test, routes.createInvitation, {
      cookie: adminCookie,
      payload: { email: "a@example.com", sendByEmail: true, verifyEmail: true },
    });
    expectProblem(answer, 409, problemTypes.smtpNotConfigured);
    expect(tableRows(test, "invitations")).toEqual([]);
    expect(test.audited("invitation.created")).toEqual([]);
  });

  it("emails the link only when asked, resends only those, and keeps the invitation when sending fails", async () => {
    const smtp = await startFakeSmtp();
    test.services.mail.updateSettings(
      { host: "127.0.0.1", port: smtp.port, tlsMode: "none", username: null, fromAddress: "noreply@example.com" },
      systemContext,
    );
    const notAsked = await callRoute(test, routes.createInvitation, { cookie: adminCookie, payload: { email: "al@example.com" } });
    expect(notAsked.json<CreatedInvitation>()).toMatchObject({ emailed: false, invitation: { sendByEmail: false } });
    expect(smtp.received).toEqual([]);
    expectProblem(
      await callRoute(test, routes.resendInvitation, { cookie: adminCookie, params: notAsked.json<CreatedInvitation>().invitation.id }),
      409,
      problemTypes.invitationInvalid,
    );
    expect(smtp.received).toEqual([]);

    const sendAndVerify = { sendByEmail: true, verifyEmail: true } as const;
    const created = await callRoute(test, routes.createInvitation, {
      cookie: adminCookie,
      payload: { email: "bea@example.com", ...sendAndVerify },
    });
    const body = created.json<CreatedInvitation>();
    expect(body).toMatchObject({ emailed: true, invitation: { sendByEmail: true, verifyEmail: true } });
    expect(smtp.received.map((mail) => mail.to)).toEqual([["bea@example.com"]]);
    expect(smtp.received[0]?.raw).toContain(body.link);
    expect(test.audited("invitation.created").find((event) => event.targetId === body.invitation.id)?.details).toMatchObject({
      sendByEmail: true,
      verifyEmail: true,
      emailed: true,
    });

    const again = await callRoute(test, routes.resendInvitation, { cookie: adminCookie, params: body.invitation.id });
    expect(again.statusCode).toBe(200);
    expect(smtp.received).toHaveLength(2);
    expect(test.audited("invitation.resent").map((event) => event.targetId)).toEqual([body.invitation.id]);
    const withoutEmail = await createTestInvitation(test);
    expectProblem(
      await callRoute(test, routes.resendInvitation, { cookie: adminCookie, params: withoutEmail.id }),
      409,
      problemTypes.invitationInvalid,
    );

    await smtp.close();
    const unsent = await callRoute(test, routes.createInvitation, {
      cookie: adminCookie,
      payload: { email: "cy@example.com", ...sendAndVerify },
    });
    expect(unsent.statusCode).toBe(201);
    expect(unsent.json<CreatedInvitation>()).toMatchObject({
      emailed: false,
      invitation: { state: "pending", sendByEmail: true, verifyEmail: true },
    });
    expectProblem(
      await callRoute(test, routes.resendInvitation, { cookie: adminCookie, params: body.invitation.id }),
      502,
      problemTypes.mailSendFailed,
    );
  });
});

describe("The invitation page", () => {
  it("offers the enabled providers and a free username from the invitation's email", async () => {
    const disabled = await addTestProvider(test, {
      kind: "github",
      name: "Off",
      clientId: "gh",
      clientSecret: "gh-secret-0123456789",
      enabled: false,
    });
    test.createUser({ username: "taken" });
    const offer = async (email?: string) =>
      (
        await callRoute(test, routes.getInvitation, {
          params: (await createTestInvitation(test, email === undefined ? {} : { email })).token,
        })
      ).json();

    expect(await offer("Jane.Doe+files@example.com")).toEqual({
      providers: [{ id: provider.id, kind: "oidc", name: "Test IdP" }],
      suggestedUsername: "jane.doefiles",
      verifyEmail: false,
    });
    const verified = await createTestInvitation(test, { email: "v@example.com", verifyEmail: true });
    expect((await callRoute(test, routes.getInvitation, { params: verified.token })).json()).toMatchObject({ verifyEmail: true });
    expect(JSON.stringify(await offer())).not.toContain(disabled.id);
    expect(await offer()).toMatchObject({ suggestedUsername: null });
    expect(await offer("taken@example.com")).toMatchObject({ suggestedUsername: null });
    expect(await offer("x@example.com")).toMatchObject({ suggestedUsername: null });
  });

  it("answers unknown, malformed, expired, used and revoked links byte for byte alike, and creates no account", async () => {
    const userA = test.createUser({ username: "usera" });
    const userB = test.createUser({ username: "userb" });
    const expiredInvite = await createTestInvitation(test, { expiresInDays: 1 });
    const expiredRelink = await createTestRelink(test, userA.id);
    test.clock.advance(2 * DAY_MS);
    const revokedInvite = await createTestInvitation(test);
    test.services.invitations.revoke(revokedInvite.id, systemContext);
    const revokedRelink = await createTestRelink(test, userB.id);
    await createTestRelink(test, userB.id);
    const usedInvite = await createTestInvitation(test);
    expectSignedInAt(await accept(usedInvite.token, { username: "winner" }, { sub: "winner-sub" }));
    const before = usernames();

    const invalid = [newToken(), "not-a-token", "not.a.token_", expiredInvite.token, revokedInvite.token, usedInvite.token];
    const invalidRelinks = [newToken(), "x", expiredRelink, revokedRelink, usedInvite.token];
    const askers: [string[], (token: string) => Promise<LightMyRequestResponse>][] = [
      [invalid, (token) => test.app.inject({ method: "GET", url: `/api/v1/invitations/${token}`, headers: viaProxy })],
      [invalid, (token) => postAccept(test, token, { providerId: provider.id, username: "newbie" })],
      [invalidRelinks, (token) => test.app.inject({ method: "GET", url: `/api/v1/relink/${token}`, headers: viaProxy })],
      [invalidRelinks, (token) => postRelinkStart(test, token, provider.id)],
    ];
    const bodies = new Set<string>();
    for (const [tokens, ask] of askers) {
      // Past the per-IP limit of the link pages otherwise.
      test.clock.advance(MINUTE_MS);
      const answers = [];
      for (const token of tokens) answers.push(comparable(await ask(token)));
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
      expect(answers[0]?.status).toBe(404);
      bodies.add(answers[0]?.body ?? "");
    }
    expect([...bodies]).toEqual([JSON.stringify({ type: problemTypes.invitationInvalid, title: "This link is not valid", status: 404 })]);
    expect(usernames()).toEqual(before);
  });

  it("accepts an invitation: the account, its home, the link and an active session, all at once", async () => {
    const invitation = await createTestInvitation(test, { email: "Alice@Example.com" });
    const answer = await accept(
      invitation.token,
      { username: "alice", displayName: "Alice A" },
      { sub: "alice-sub", email: "else@idp.test" },
    );
    const cookie = expectSignedInAt(answer);

    const session = (await sessionOf(cookie)).json<Session>();
    // The invitation's email, never the provider's (threat model, T9).
    expect(session).toMatchObject({
      state: "active",
      account: { username: "alice", email: "alice@example.com", displayName: "Alice A", role: "user" },
    });
    expect(existsSync(home("alice"))).toBe(true);
    expect(tableRows(test, "homes")).toEqual([expect.objectContaining({ username: "alice", path: "alice" })]);
    expect(tableRows(test, "linked_sign_ins")).toEqual([expect.objectContaining({ subject: "alice-sub", email_at_link: "else@idp.test" })]);
    const listed = (await callRoute(test, routes.listInvitations, { cookie: adminCookie })).json<Invitations>();
    expect(listed.invitations[0]).toMatchObject({ state: "accepted", acceptedUsername: "alice" });

    const accountId = session.account.id;
    expect(test.audited("account.created").map((event) => [event.targetId, event.details])).toEqual([
      [accountId, { username: "alice", invitationId: invitation.id }],
    ]);
    expect(test.audited("linked-sign-in.added")).toEqual([expect.objectContaining({ targetId: accountId, actorUsername: "alice" })]);
    expect(test.audited("invitation.accepted").map((event) => [event.targetId, event.details])).toEqual([
      [invitation.id, { accountId, username: "alice" }],
    ]);
    expect(test.audited("sign-in.succeeded").find((event) => event.targetId === accountId)?.details).toEqual({
      method: "sso",
      secondFactor: null,
    });
    expect(JSON.stringify(test.audited())).not.toContain(invitation.token);

    expectSignedInAt(await ssoSignIn({ sub: "alice-sub" }));
    expectProblem(await callRoute(test, routes.getInvitation, { params: invitation.token }), 404, problemTypes.invitationInvalid);
  });

  it("leaves the account without an email when another account has the invitation's", async () => {
    const invitation = await createTestInvitation(test, { email: "admin@example.com" });
    const cookie = expectSignedInAt(await accept(invitation.token, { username: "second" }, { sub: "second-sub" }));
    expect((await sessionOf(cookie)).json<Session>().account.email).toBeNull();
  });

  it("links only the provider's (issuer, subject): an invitation to an existing user's email makes a new account", async () => {
    const existing = test.createUser({ username: "existing", email: "shared@example.com" });
    linkTestIdentity(test, existing.id, provider, "existing-sub");
    const invitation = await createTestInvitation(test, { email: "shared@example.com" });
    const cookie = expectSignedInAt(
      await accept(invitation.token, { username: "newcomer" }, { sub: "newcomer-sub", email: "shared@example.com" }),
    );
    const newcomer = (await sessionOf(cookie)).json<Session>().account;
    expect(newcomer).toMatchObject({ username: "newcomer", email: null });
    expect(newcomer.id).not.toBe(existing.id);
    expect(tableRows(test, "linked_sign_ins").map((row) => [row["user_id"], row["issuer"], row["subject"]])).toEqual(
      expect.arrayContaining([
        [existing.id, rig.idp.issuer, "existing-sub"],
        [newcomer.id, rig.idp.issuer, "newcomer-sub"],
      ]),
    );
    expect(tableRows(test, "linked_sign_ins")).toHaveLength(2);
    // A third identity with that very email signs in as nobody.
    expectSentBack(await ssoSignIn({ sub: "third-sub", email: "shared@example.com" }), SSO_SIGN_IN_FAILED_PATH);
  });

  it("refuses a taken or reserved username at the start, and frees a reservation whose folder is gone", async () => {
    const invitation = await createTestInvitation(test);
    test.createUser({ username: "bob" });
    expectProblem(await postAccept(test, invitation.token, { providerId: provider.id, username: "bob" }), 409, problemTypes.usernameTaken);

    await test.services.resources.createHome("carol");
    test.database.sqlite.prepare("INSERT INTO reserved_usernames (username, created_at) VALUES ('carol', 'then')").run();
    expectProblem(
      await postAccept(test, invitation.token, { providerId: provider.id, username: "carol" }),
      409,
      problemTypes.usernameReserved,
    );

    rmSync(home("carol"), { recursive: true });
    expect((await postAccept(test, invitation.token, { providerId: provider.id, username: "carol" })).statusCode).toBe(200);
    expect(tableRows(test, "reserved_usernames")).toEqual([]);
    expect(tableRows(test, "homes")).toEqual([]);
    expectProblem(
      await postAccept(test, invitation.token, { providerId: "01900000-0000-7000-8000-000000000000", username: "dora" }),
      404,
      problemTypes.notFound,
    );
  });

  it("checks the username again at the callback", async () => {
    const invitation = await createTestInvitation(test);
    const taken = await startTestAccept(test, invitation.token, { providerId: provider.id, username: "dave" });
    const reserved = await startTestAccept(test, invitation.token, { providerId: provider.id, username: "erin" });
    test.createUser({ username: "dave" });
    await test.services.resources.createHome("erin");
    test.database.sqlite.prepare("INSERT INTO reserved_usernames (username, created_at) VALUES ('erin', 'then')").run();

    const failed = `${invitationPath(invitation.token)}?error=`;
    expectSentBack(
      await followToCallback(test, rig.idp.authorize(taken.url, { sub: "dave-sub" }), taken.flowCookie),
      `${failed}username-taken`,
    );
    expectSentBack(
      await followToCallback(test, rig.idp.authorize(reserved.url, { sub: "erin-sub" }), reserved.flowCookie),
      `${failed}username-reserved`,
    );
    expect(existsSync(home("dave"))).toBe(false);
    expect(sorted(usernames())).toEqual(["admin", "dave"]);
    expect(tableRows(test, "linked_sign_ins")).toEqual([]);
  });

  it("refuses an identity linked to any account, and keeps nothing", async () => {
    const someone = test.createUser({ username: "someone" });
    linkTestIdentity(test, someone.id, provider, "known-sub");
    const invitation = await createTestInvitation(test);
    expectSentBack(
      await accept(invitation.token, { username: "fresh" }, { sub: "known-sub" }),
      `${invitationPath(invitation.token)}?error=identity-already-linked`,
    );
    expect(usernames()).not.toContain("fresh");
    expect(existsSync(home("fresh"))).toBe(false);
    expect((await callRoute(test, routes.getInvitation, { params: invitation.token })).statusCode).toBe(200);
  });

  it("lets exactly one of two concurrent accepts of one invitation through", async () => {
    const invitation = await createTestInvitation(test);
    const first = await startTestAccept(test, invitation.token, { providerId: provider.id, username: "first" });
    const second = await startTestAccept(test, invitation.token, { providerId: provider.id, username: "second" });
    const answers = await Promise.all([
      followToCallback(test, rig.idp.authorize(first.url, { sub: "first-sub" }), first.flowCookie),
      followToCallback(test, rig.idp.authorize(second.url, { sub: "second-sub" }), second.flowCookie),
    ]);

    const locations = answers.map((answer) => String(answer.headers.location));
    expect(sorted(locations)).toEqual(sorted([`${invitationPath(invitation.token)}?error=invitation-invalid`, SSO_SIGN_IN_COMPLETE_PATH]));
    const winner = answers[0]?.headers.location === SSO_SIGN_IN_COMPLETE_PATH ? "first" : "second";
    const loser = winner === "first" ? "second" : "first";
    expect(sorted(usernames())).toEqual(sorted(["admin", winner]));
    expect(existsSync(home(winner))).toBe(true);
    expect(existsSync(home(loser))).toBe(false);
    expect(tableRows(test, "linked_sign_ins")).toHaveLength(1);
  });

  it("undoes everything when the transaction fails: no account, no link, no folder, and the invitation still pending", async () => {
    const invitation = await createTestInvitation(test);
    const someone = test.createUser({ username: "someone" });
    linkTestIdentity(test, someone.id, provider, "raced-sub");
    // As if another callback linked the identity between the checks and the transaction.
    const findByIdentity = vi.spyOn(test.services.sso.linkedSignIns, "findByIdentity").mockReturnValue(undefined);
    expectSentBack(
      await accept(invitation.token, { username: "racer" }, { sub: "raced-sub" }),
      `${invitationPath(invitation.token)}?error=identity-already-linked`,
    );
    findByIdentity.mockRestore();

    const create = vi.spyOn(test.services.accounts, "create").mockImplementation(() => {
      throw new Error("disk full");
    });
    expectSentBack(
      await accept(invitation.token, { username: "racer" }, { sub: "racer-sub" }),
      `${invitationPath(invitation.token)}?error=accept-failed`,
    );
    create.mockRestore();

    expect(usernames()).not.toContain("racer");
    expect(existsSync(home("racer"))).toBe(false);
    expect(tableRows(test, "homes")).toEqual([]);
    expect(tableRows(test, "linked_sign_ins")).toHaveLength(1);
    expect(test.audited("account.created")).toEqual([]);
    expect(tableRows(test, "invitations")[0]).toMatchObject({ accepted_at: null, accepted_user_id: null });
    expectSignedInAt(await accept(invitation.token, { username: "racer" }, { sub: "racer-sub" }));
  });

  it("refuses an invitation revoked while the user was at the provider", async () => {
    const invitation = await createTestInvitation(test);
    const started = await startTestAccept(test, invitation.token, { providerId: provider.id, username: "late" });
    test.services.invitations.revoke(invitation.id, systemContext);
    expectSentBack(
      await followToCallback(test, rig.idp.authorize(started.url, { sub: "late-sub" }), started.flowCookie),
      `${invitationPath(invitation.token)}?error=invitation-invalid`,
    );
    expect(usernames()).not.toContain("late");
    expect(existsSync(home("late"))).toBe(false);
  });

  it("sends a refusal at the provider back to the invitation page", async () => {
    const invitation = await createTestInvitation(test);
    const started = await startTestAccept(test, invitation.token, { providerId: provider.id, username: "nope" });
    const callback = rig.idp.authorize(started.url, { sub: "nope-sub" });
    callback.searchParams.set("state", "tampered");
    expectSentBack(await followToCallback(test, callback, started.flowCookie), `${invitationPath(invitation.token)}?error=accept-failed`);
    expect(usernames()).not.toContain("nope");
  });

  it("creates no account for an SSO sign-in of an unknown identity", async () => {
    const before = usernames();
    expectSentBack(await ssoSignIn({ sub: "nobody", email: "admin@example.com" }), SSO_SIGN_IN_FAILED_PATH);
    expect(usernames()).toEqual(before);
  });

  it("limits the link pages to 20 requests a minute per IP", async () => {
    const ask = () => test.app.inject({ method: "GET", url: `/api/v1/invitations/${newToken()}`, headers: viaProxy });
    for (let request = 0; request < 20; request += 1) expect((await ask()).statusCode).toBe(404);
    const limited = await ask();
    expectProblem(limited, 429, problemTypes.rateLimited);
    expect(limited.headers["retry-after"]).toBe("60");
    expectProblem(await postAccept(test, "x", { providerId: provider.id, username: "Not Valid" }), 429, problemTypes.rateLimited);
    expect(test.audited("rate-limit.triggered").map((event) => event.details)).toEqual([{ limit: "link-page-per-ip", key: "127.0.0.1" }]);
    expect((await callRoute(test, routes.listInvitations, { cookie: adminCookie })).statusCode).toBe(200);

    test.clock.advance(MINUTE_MS);
    expect((await ask()).statusCode).toBe(404);
  });

  it("has its token envelopes re-encrypted by rotate-key", async () => {
    const invitation = await createTestInvitation(test);
    const newKey = Buffer.alloc(32, 9);
    const rotated = rotateMasterKey({ database: test.database, oldKey: Buffer.alloc(32, 7), newKey, columns: envelopeColumns });
    expect(rotated).toContainEqual({ table: "invitations", column: "token", reencrypted: 1 });
    const envelope = String(tableRows(test, "invitations")[0]?.["token"]);
    expect(createSecrets(newKey).decrypt("invitation", tokenAad(invitation.id), envelope)).toBe(invitation.token);
  });
});

const verifiedInvitation = (email = "Alice@Example.com") => createTestInvitation(test, { email, verifyEmail: true });

/** Sent back to the invitation page with `failure`, with nothing made and the refusal audited. */
function expectRefused(response: LightMyRequestResponse, invitation: TestInvitation, failure: string, providerId: string): void {
  expectSentBack(response, `${invitationPath(invitation.token)}?error=${failure}`);
  expect(usernames()).toEqual(["admin"]);
  expect(existsSync(home("alice"))).toBe(false);
  expect(tableRows(test, "linked_sign_ins")).toEqual([]);
  expect(test.audited("invitation.refused").map((event) => [event.targetId, event.outcome, event.details])).toEqual([
    [invitation.id, "denied", { reason: failure, providerId }],
  ]);
}

describe("Invitations that require a verified email (threat model, T9)", () => {
  it("accepts when the provider's verified email is the invitation's, trimmed and whatever the case", async () => {
    const invitation = await verifiedInvitation();
    const answer = await accept(invitation.token, { username: "alice" }, { sub: "alice-sub", email: "  ALICE@example.COM " });
    const session = (await sessionOf(expectSignedInAt(answer))).json<Session>();
    expect(session.account).toMatchObject({ username: "alice", email: "alice@example.com" });
    expect(test.audited("invitation.refused")).toEqual([]);

    const quoted = await verifiedInvitation("bea@example.com");
    expectSignedInAt(await accept(quoted.token, { username: "bea" }, { sub: "bea-sub", email: "bea@example.com", emailVerified: "true" }));
  });

  it("refuses an email the provider doesn't report as verified", async () => {
    const invitation = await verifiedInvitation();
    const identity = { sub: "alice-sub", email: "alice@example.com", emailVerified: false };
    expectRefused(await accept(invitation.token, { username: "alice" }, identity), invitation, "email-not-verified", provider.id);
    expect((await callRoute(test, routes.getInvitation, { params: invitation.token })).statusCode).toBe(200);
  });

  it("refuses a provider that doesn't send email_verified at all", async () => {
    const invitation = await verifiedInvitation();
    const identity = { sub: "alice-sub", email: "alice@example.com", emailVerified: null };
    expectRefused(await accept(invitation.token, { username: "alice" }, identity), invitation, "email-not-verified", provider.id);
  });

  it("refuses another verified email, and never records the provider's", async () => {
    const invitation = await verifiedInvitation();
    const identity = { sub: "alice-sub", email: "alice@elsewhere.test" };
    expectRefused(await accept(invitation.token, { username: "alice" }, identity), invitation, "email-mismatch", provider.id);
    expect(JSON.stringify(test.audited())).not.toContain("elsewhere.test");
  });

  it("checks every verified GitHub email, not only the primary one", async () => {
    const github = await addTestProvider(test, {
      kind: "github",
      name: "GitHub",
      clientId: "gh",
      clientSecret: FAKE_CLIENT_SECRET,
      enabled: true,
    });
    const acceptAtGitHub = async (token: string, username: string, emails: FakeGitHubUser["emails"]) => {
      const { url, flowCookie } = await startTestAccept(test, token, { providerId: github.id, username });
      return followToCallback(test, rig.github.authorize(url, { id: 7, login: "octo", name: null, emails }), flowCookie);
    };

    const unverified = await verifiedInvitation();
    expectRefused(
      await acceptAtGitHub(unverified.token, "alice", [{ email: "alice@example.com", primary: true, verified: false }]),
      unverified,
      "email-not-verified",
      github.id,
    );

    const secondary = await verifiedInvitation();
    const answer = await acceptAtGitHub(secondary.token, "alice", [
      { email: "octo@users.example.com", primary: true, verified: true },
      { email: "Alice@example.com", primary: false, verified: true },
    ]);
    expect((await sessionOf(expectSignedInAt(answer))).json<Session>().account.email).toBe("alice@example.com");
  });

  it("leaves an invitation without the requirement as it was: any provider email, or none", async () => {
    const invitation = await createTestInvitation(test, { email: "alice@example.com" });
    const identity = { sub: "alice-sub", email: "other@elsewhere.test", emailVerified: false };
    expectSignedInAt(await accept(invitation.token, { username: "alice" }, identity));
    expect(test.audited("invitation.refused")).toEqual([]);
  });
});

describe("Re-link links", () => {
  let bob: ReturnType<TestApp["createUser"]>;

  beforeEach(() => {
    bob = test.createUser({ username: "bob" });
    linkTestIdentity(test, bob.id, provider, "bob-old");
  });

  it("replaces the user's sign-in, signs them out everywhere, and works once", async () => {
    const bobCookie = test.startSession(bob);
    const created = await callRoute(test, routes.createRelinkLink, { cookie: adminCookie, params: bob.id });
    expect(created.statusCode).toBe(201);
    const { link, expiresAt, emailed } = created.json<{ link: string; expiresAt: string; emailed: boolean }>();
    const token = tokenOfLink(link);
    expect(link).toBe(`${testOrigin}${relinkPath(token)}`);
    expect(expiresAt).toBe(new Date(test.clock.now().getTime() + DAY_MS).toISOString());
    expect(emailed).toBe(false);
    expect((await callRoute(test, routes.getRelink, { params: token })).json()).toEqual({
      providers: [{ id: provider.id, kind: "oidc", name: "Test IdP" }],
    });

    const cookie = expectSignedInAt(await relink(token, { sub: "bob-new" }));
    expect((await sessionOf(cookie)).json<Session>().account.username).toBe("bob");
    expect((await sessionOf(bobCookie)).statusCode).toBe(401);
    expect(tableRows(test, "linked_sign_ins").map((row) => row["subject"])).toEqual(["bob-new"]);
    expectSentBack(await ssoSignIn({ sub: "bob-old" }), SSO_SIGN_IN_FAILED_PATH);
    expectSignedInAt(await ssoSignIn({ sub: "bob-new" }));
    expectProblem(await callRoute(test, routes.getRelink, { params: token }), 404, problemTypes.invitationInvalid);

    const relinkId = test.audited("relink.created")[0]?.details["relinkId"];
    expect(test.audited("relink.created")[0]).toMatchObject({
      targetId: bob.id,
      details: { expiresAt, emailed: false, revokedEarlier: 0 },
    });
    expect(test.audited("relink.used").map((event) => [event.targetId, event.details])).toEqual([
      [bob.id, { relinkId, providerId: provider.id, removedLinks: 1, revokedSessions: 1 }],
    ]);
    expect(test.audited("linked-sign-in.removed")).toHaveLength(1);
    expect(test.audited("linked-sign-in.added")).toHaveLength(1);
    expect(JSON.stringify(test.audited())).not.toContain(token);
  });

  it("refuses an identity linked to another account, and keeps the old sign-in and the link", async () => {
    const other = test.createUser({ username: "other" });
    linkTestIdentity(test, other.id, provider, "other-sub");
    const token = await createTestRelink(test, bob.id);
    expectSentBack(await relink(token, { sub: "other-sub" }), `${relinkPath(token)}?error=identity-already-linked`);
    expectSignedInAt(await ssoSignIn({ sub: "bob-old" }));
    expect((await callRoute(test, routes.getRelink, { params: token })).statusCode).toBe(200);
    // Linked to the same user, it is simply linked again.
    expectSignedInAt(await relink(token, { sub: "bob-old" }));
  });

  it("revokes the user's earlier link, needs a recent sign-in, and is only for users", async () => {
    const first = await createTestRelink(test, bob.id);
    await createTestRelink(test, bob.id);
    expectProblem(await callRoute(test, routes.getRelink, { params: first }), 404, problemTypes.invitationInvalid);

    const adminId = test.services.accounts.findAdmin()?.id ?? "";
    expectProblem(await callRoute(test, routes.createRelinkLink, { cookie: adminCookie, params: adminId }), 404, problemTypes.notFound);
    expectProblem(await callRoute(test, routes.createRelinkLink, { cookie: adminCookie }), 404, problemTypes.notFound);
    test.clock.advance(11 * MINUTE_MS);
    expectProblem(
      await callRoute(test, routes.createRelinkLink, { cookie: adminCookie, params: bob.id }),
      403,
      problemTypes.recentSignInRequired,
    );
  });

  it("refuses a disabled user's link at the callback", async () => {
    const token = await createTestRelink(test, bob.id);
    test.services.accounts.setStatus(bob.id, "disabled");
    expectSentBack(await relink(token, { sub: "bob-new" }), `${relinkPath(token)}?error=relink-failed`);
    expect(tableRows(test, "linked_sign_ins").map((row) => row["subject"])).toEqual(["bob-old"]);
  });
});
