import {
  GITHUB_ISSUER,
  LINKED_SIGN_INS_PATH,
  problemTypes,
  routes,
  SSO_SIGN_IN_COMPLETE_PATH,
  SSO_SIGN_IN_FAILED_PATH,
  type LinkedSignIns,
  type SsoProvider,
} from "@not-unreachable/contracts";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSsoTestApp,
  expectProblem,
  FAKE_CLIENT_SECRET,
  FAKE_ISSUER,
  fakeOidcProvider,
  addTestProvider,
  followToCallback,
  linkTestIdentity,
  sameOriginWrite,
  sessionCookieHeader,
  sessionTokenFrom,
  startSsoSignIn,
  startTestLink,
  testOrigin,
  testSecrets,
  viaProxy,
  type FakeIdentity,
  type IdTokenTampering,
  type SsoTestRig,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import { users, type AccountRecord } from "../accounts/index.ts";
import { createSecrets, envelopeColumns, hashToken, newId, rotateMasterKey, SecretDecryptionError } from "../platform/index.ts";
import { SSO_COOKIE, SSO_FLOW_LIFETIME_MS } from "./index.ts";

const CLEARED_SSO_COOKIE = `${SSO_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

let rig: SsoTestRig;
let test: TestApp;

beforeEach(async () => {
  rig = await buildSsoTestApp();
  test = rig.test;
});
afterEach(() => rig.close());

const setCookies = (response: LightMyRequestResponse): string[] => {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header === undefined ? [] : [header];
};

/** A whole sign-in at the fake OIDC provider, as `identity`. */
async function signInAs(provider: Pick<SsoProvider, "id">, identity: FakeIdentity): Promise<LightMyRequestResponse> {
  const { url, flowCookie } = await startSsoSignIn(test, provider.id);
  return followToCallback(test, rig.idp.authorize(url, identity), flowCookie);
}

const expectRefused = (response: LightMyRequestResponse): void => {
  expect(response.statusCode).toBe(303);
  expect(response.headers.location).toBe(SSO_SIGN_IN_FAILED_PATH);
  expect(setCookies(response)).toEqual([CLEARED_SSO_COOKIE]);
  expect(response.body).toBe("");
};

/** The reasons `sign-in.failed` recorded, sorted: events of one millisecond come in no set order. */
const ssoFailures = () =>
  test
    .audited("sign-in.failed")
    .map((event) => event.details["reason"])
    .filter((reason) => typeof reason === "string")
    .toSorted();

/** An answer without its Date, which differs from one request to the next. */
const comparable = (response: LightMyRequestResponse) => {
  const { date: _date, ...headers } = response.headers;
  return { status: response.statusCode, headers, body: response.body };
};

const disable = (user: AccountRecord): void => {
  test.database.db.update(users).set({ status: "disabled" }).where(eq(users.id, user.id)).run();
};

describe("Sign-in providers (the admin's tab)", () => {
  let cookie: string;

  beforeEach(async () => {
    await test.createAdmin();
    cookie = await test.signIn("admin");
  });

  it("adds an OIDC provider after discovery and never answers, stores or audits its secret in the clear", async () => {
    const added = await callRoute(test, routes.addSsoProvider, { cookie, payload: fakeOidcProvider() });
    expect(added.statusCode).toBe(201);
    const provider = added.json<SsoProvider>();
    expect(provider).toEqual({
      id: expect.any(String),
      kind: "oidc",
      name: "Test IdP",
      issuer: FAKE_ISSUER,
      clientId: "nu-client",
      clientSecretSet: true,
      enabled: true,
      redirectUri: `${testOrigin}/api/v1/sso/${provider.id}/callback`,
      linkedSignIns: 0,
      createdAt: test.clock.now().toISOString(),
    });

    const newSecret = "another-client-secret-9876543210";
    const changed = await callRoute(test, routes.changeSsoProvider, {
      cookie,
      params: provider.id,
      payload: { name: "Renamed", clientSecret: newSecret },
    });
    expect(changed.statusCode).toBe(200);
    const listed = await callRoute(test, routes.listSsoProviders, { cookie });
    expect(listed.json()).toMatchObject({ providers: [{ id: provider.id, name: "Renamed", clientSecretSet: true }] });
    const signInList = await callRoute(test, routes.listSignInProviders, {});
    expect(signInList.json()).toEqual({ providers: [{ id: provider.id, kind: "oidc", name: "Renamed" }] });

    const [row] = tableRows(test, "sso_providers");
    const envelope = String(row?.["client_secret"]);
    for (const answer of [added, changed, listed, signInList, await callRoute(test, routes.listAuditEvents, { cookie })]) {
      for (const secret of [FAKE_CLIENT_SECRET, newSecret, envelope]) expect(answer.body).not.toContain(secret);
    }
    expect(testSecrets.decrypt("sso", { table: "sso_providers", column: "client_secret", rowId: provider.id }, envelope)).toBe(newSecret);
    expect(JSON.stringify(test.audited())).not.toContain(newSecret);
    const changes = test.audited("sso-provider.changed").map((event) => event.details);
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(
      expect.arrayContaining([
        { change: "changed", kind: "oidc", name: "Renamed", fields: ["name", "clientSecret"] },
        { change: "added", kind: "oidc", name: "Test IdP", fields: ["name", "issuer", "clientId", "clientSecret", "enabled"] },
      ]),
    );
  });

  it("fixes Google's and GitHub's issuers: a second one is taken, and their issuer can't change", async () => {
    const github = (
      await callRoute(test, routes.addSsoProvider, {
        cookie,
        payload: { kind: "github", name: "GitHub", clientId: "gh", clientSecret: "gh-secret" },
      })
    ).json<SsoProvider>();
    expect(github).toMatchObject({ kind: "github", issuer: GITHUB_ISSUER });
    const google = await callRoute(test, routes.addSsoProvider, {
      cookie,
      payload: { kind: "google", name: "Google", clientId: "g", clientSecret: "g-secret" },
    });
    expect(google.json()).toMatchObject({ kind: "google", issuer: "https://accounts.google.com" });
    expectProblem(
      await callRoute(test, routes.addSsoProvider, {
        cookie,
        payload: { kind: "github", name: "Again", clientId: "x", clientSecret: "y" },
      }),
      409,
      problemTypes.ssoIssuerTaken,
    );
    expectProblem(
      await callRoute(test, routes.changeSsoProvider, { cookie, params: github.id, payload: { issuer: FAKE_ISSUER } }),
      422,
      problemTypes.validationFailed,
    );
  });

  it("adds a provider with the id its page chose, so the redirect URI registered beforehand is its own", async () => {
    const id = newId(test.clock);
    const added = await callRoute(test, routes.addSsoProvider, { cookie, payload: fakeOidcProvider({ id }) });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ id, redirectUri: `${testOrigin}/api/v1/sso/${id}/callback` });
    expect((await callRoute(test, routes.listSsoProviders, { cookie })).json()).toEqual({
      providers: [expect.objectContaining({ id, redirectUri: `${testOrigin}/api/v1/sso/${id}/callback` })],
      publicOrigin: testOrigin,
    });
    expect(tableRows(test, "sso_providers")).toMatchObject([{ id }]);
  });

  it("refuses a chosen id that is taken or isn't a UUIDv7, adding nothing", async () => {
    const github = { kind: "github", name: "GitHub", clientId: "gh", clientSecret: "gh-secret" };
    const taken = (await addTestProvider(test)).id;
    expectProblem(
      await callRoute(test, routes.addSsoProvider, { cookie, payload: { ...github, id: taken } }),
      409,
      problemTypes.ssoProviderIdTaken,
    );
    // Not a UUID, a UUIDv4, a UUIDv7 without its hyphens, and one in upper case (ids are lower case).
    const fresh = newId(test.clock);
    for (const malformed of ["not-an-id", "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a01", fresh.replaceAll("-", ""), fresh.toUpperCase()]) {
      expectProblem(
        await callRoute(test, routes.addSsoProvider, { cookie, payload: { ...github, id: malformed } }),
        400,
        problemTypes.validationFailed,
      );
    }
    expect(tableRows(test, "sso_providers")).toMatchObject([{ id: taken }]);
  });

  it("refuses an issuer whose discovery names another issuer, times out, can't be reached, or isn't https", async () => {
    const add = (issuer: string) => callRoute(test, routes.addSsoProvider, { cookie, payload: fakeOidcProvider({ issuer }) });
    rig.idp.discoveryIssuer = "https://other.test";
    expectProblem(await add(FAKE_ISSUER), 422, problemTypes.ssoDiscoveryFailed);
    // A trailing slash is another issuer: links are matched on it exactly.
    rig.idp.discoveryIssuer = FAKE_ISSUER;
    expectProblem(await add(`${FAKE_ISSUER}/`), 422, problemTypes.ssoDiscoveryFailed);
    rig.idp.hangDiscovery = true;
    expectProblem(await add(FAKE_ISSUER), 422, problemTypes.ssoDiscoveryFailed);
    rig.idp.hangDiscovery = false;
    expectProblem(await add("https://unreachable.test"), 422, problemTypes.ssoDiscoveryFailed);
    expectProblem(await add("http://idp.test"), 400, problemTypes.validationFailed);
    expect(tableRows(test, "sso_providers")).toEqual([]);

    const provider = (await add(FAKE_ISSUER)).json<SsoProvider>();
    expectProblem(await add(FAKE_ISSUER), 409, problemTypes.ssoIssuerTaken);
    rig.idp.discoveryIssuer = "https://other.test";
    expectProblem(
      await callRoute(test, routes.changeSsoProvider, {
        cookie,
        params: provider.id,
        payload: { issuer: "https://idp.test/realm", clientSecret: "secret-for-the-new-issuer" },
      }),
      422,
      problemTypes.ssoDiscoveryFailed,
    );
  });

  it("never sends a saved client secret to a new issuer: changing the issuer needs the secret again", async () => {
    const provider = await addTestProvider(test);
    const newIssuer = "https://idp.test/realm";
    const change = (payload: Record<string, unknown>) =>
      callRoute(test, routes.changeSsoProvider, { cookie, params: provider.id, payload });
    expectProblem(await change({ issuer: newIssuer }), 400, problemTypes.badRequest);
    expect(tableRows(test, "sso_providers")).toMatchObject([{ issuer: FAKE_ISSUER }]);
    // With the secret typed again the change goes on to discovery, which the fake IdP serves only at its own issuer.
    expectProblem(await change({ issuer: newIssuer, clientSecret: "secret-for-the-new-issuer" }), 422, problemTypes.ssoDiscoveryFailed);
  });

  it("refuses removing a provider, or changing its issuer, while linked sign-ins use it", async () => {
    const provider = await addTestProvider(test);
    const user = test.createUser();
    const link = linkTestIdentity(test, user.id, provider, "subject-1");
    expect((await callRoute(test, routes.listSsoProviders, { cookie })).json()).toMatchObject({ providers: [{ linkedSignIns: 1 }] });
    expectProblem(await callRoute(test, routes.removeSsoProvider, { cookie, params: provider.id }), 409, problemTypes.ssoProviderInUse);
    expectProblem(
      await callRoute(test, routes.changeSsoProvider, { cookie, params: provider.id, payload: { issuer: "https://idp.test/realm" } }),
      409,
      problemTypes.ssoProviderInUse,
    );
    expect(tableRows(test, "sso_providers")).toMatchObject([{ issuer: FAKE_ISSUER }]);

    test.services.sso.linkedSignIns.unlink({ id: user.id, role: "admin" }, link, { actor: { kind: "system" } });
    expect((await callRoute(test, routes.removeSsoProvider, { cookie, params: provider.id })).statusCode).toBe(204);
    expect(tableRows(test, "sso_providers")).toEqual([]);
    expect(test.audited("sso-provider.changed").find((event) => event.details["change"] === "removed")).toMatchObject({
      targetId: provider.id,
      details: { kind: "oidc", fields: [] },
    });
  });

  it("needs a recent sign-in for every write, and is the admin's only", async () => {
    const admin = test.services.accounts.findAdmin();
    if (admin === undefined) throw new Error("no admin");
    const stale = test.startSession(admin, { recentSignIn: false });
    expectProblem(
      await callRoute(test, routes.addSsoProvider, { cookie: stale, payload: fakeOidcProvider() }),
      403,
      problemTypes.recentSignInRequired,
    );
    const user = test.startSession(test.createUser());
    expectProblem(await callRoute(test, routes.listSsoProviders, { cookie: user }), 403, problemTypes.forbidden);
  });
});

describe("SSO sign-in (threat model, T9)", () => {
  let provider: SsoProvider;

  beforeEach(async () => {
    provider = await addTestProvider(test);
  });

  it("gives a linked user an active session with a recent sign-in, through PKCE, state and nonce bound to the flow cookie", async () => {
    const user = test.createUser();
    const link = linkTestIdentity(test, user.id, provider, "user-subject");

    const started = await startSsoSignIn(test, provider.id);
    const [flowCookieHeader] = setCookies(started.response);
    expect(flowCookieHeader).toMatch(new RegExp(`^${SSO_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$`));
    const authorization = new URL(started.url);
    expect(authorization.origin + authorization.pathname).toBe(`${FAKE_ISSUER}/authorize`);
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      client_id: "nu-client",
      response_type: "code",
      redirect_uri: `${testOrigin}/api/v1/sso/${provider.id}/callback`,
      scope: "openid email profile",
      code_challenge_method: "S256",
      state: expect.any(String),
      nonce: expect.any(String),
    });

    const [flow] = tableRows(test, "sso_flows");
    const token = started.flowCookie.slice(`${SSO_COOKIE}=`.length);
    expect(flow?.["binding_hash"]).toBe(hashToken(token));
    expect(JSON.stringify(flow)).not.toContain(token);

    const callback = rig.idp.authorize(started.url, { sub: "user-subject", email: "someone@idp.test" });
    const response = await followToCallback(test, callback, started.flowCookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
    expect(setCookies(response)[0]).toBe(CLEARED_SSO_COOKIE);
    expect(tableRows(test, "sso_flows")).toEqual([]);

    const [tokenRequest] = rig.idp.tokenRequests;
    expect(tokenRequest?.pkceMatched).toBe(true);
    expect(tokenRequest?.parameters.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(String(flow?.["code_verifier"])).not.toBe(tokenRequest?.parameters.get("code_verifier"));

    const session = await callRoute(test, routes.getSession, { cookie: sessionCookieHeader(sessionTokenFrom(response)) });
    expect(session.json()).toMatchObject({ account: { id: user.id }, state: "active", recentSignInUntil: expect.any(String) });
    expect(test.audited("sign-in.succeeded")).toMatchObject([
      { actorAccountId: user.id, targetId: user.id, details: { method: "sso", secondFactor: null } },
    ]);
    expect(tableRows(test, "linked_sign_ins").find((row) => row["id"] === link)?.["last_used_at"]).toBe(test.clock.now().toISOString());
  });

  it("always ends an admin's SSO sign-in pending its second factor, whose pass records method sso", async () => {
    const admin = await test.createAdmin();
    await test.signIn("admin");
    linkTestIdentity(test, admin.id, provider, "admin-subject");

    const response = await signInAs(provider, { sub: "admin-subject" });
    expect(response.headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
    const cookie = sessionCookieHeader(sessionTokenFrom(response));
    expect((await callRoute(test, routes.getSession, { cookie })).json()).toMatchObject({
      state: "pendingSecondFactor",
      recentSignInUntil: null,
    });
    expectProblem(await callRoute(test, routes.getProfile, { cookie }), 403, problemTypes.forbidden);
    const before = test.audited("sign-in.succeeded").length;

    const passed = await callRoute(test, routes.passTotp, { cookie, payload: { code: test.totpCode(admin.id) } });
    expect(passed.json()).toMatchObject({ state: "active" });
    const signIns = test.audited("sign-in.succeeded");
    expect(signIns).toHaveLength(before + 1);
    expect(signIns.map((event) => event.details)).toContainEqual({ method: "sso", secondFactor: "totp" });
  });

  it("refuses an unknown subject carrying the admin's email exactly as a disabled user and a disabled provider", async () => {
    const admin = await test.createAdmin({ email: "root@example.com" });
    const stranger = await signInAs(provider, { sub: "stranger", email: admin.email ?? "root@example.com" });

    const disabledUser = test.createUser({ username: "gone" });
    linkTestIdentity(test, disabledUser.id, provider, "gone-subject");
    disable(disabledUser);
    const disabled = await signInAs(provider, { sub: "gone-subject" });

    const user = test.createUser();
    linkTestIdentity(test, user.id, provider, "user-subject");
    const started = await startSsoSignIn(test, provider.id);
    await test.services.sso.providers.change(provider.id, { enabled: false }, { actor: { kind: "system" } });
    const disabledProvider = await followToCallback(test, rig.idp.authorize(started.url, { sub: "user-subject" }), started.flowCookie);

    for (const response of [stranger, disabled, disabledProvider]) expectRefused(response);
    expect(comparable(disabled)).toEqual(comparable(stranger));
    expect(comparable(disabledProvider)).toEqual(comparable(stranger));
    expect(ssoFailures()).toEqual(["disabled", "disabled-provider", "unknown-identity"]);
    const failures = test.audited("sign-in.failed");
    for (const failure of failures)
      expect(failure).toMatchObject({ actorKind: "anonymous", details: { method: "sso", providerId: provider.id } });
    expect(failures.find((failure) => failure.details["reason"] === "disabled")?.targetId).toBe(disabledUser.id);
    expect(failures.find((failure) => failure.details["reason"] === "unknown-identity")?.targetId).toBeNull();
    expect(test.audited("sign-in.succeeded")).toEqual([]);
  });

  it("stops at once when the provider is disabled, and its links work again once re-enabled", async () => {
    const user = test.createUser();
    linkTestIdentity(test, user.id, provider, "user-subject");
    await test.services.sso.providers.change(provider.id, { enabled: false }, { actor: { kind: "system" } });
    expect((await callRoute(test, routes.listSignInProviders, {})).json()).toEqual({ providers: [] });
    expectProblem(await callRoute(test, routes.startSsoSignIn, { params: provider.id }), 404, problemTypes.notFound);

    await test.services.sso.providers.change(provider.id, { enabled: true }, { actor: { kind: "system" } });
    expect((await signInAs(provider, { sub: "user-subject" })).headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
  });

  it("refuses a wrong, reused, expired or cookie-less state, and uses a flow once whatever happens", async () => {
    const user = test.createUser();
    linkTestIdentity(test, user.id, provider, "user-subject");
    const identity = { sub: "user-subject" };

    const wrong = await startSsoSignIn(test, provider.id);
    const wrongCallback = rig.idp.authorize(wrong.url, identity);
    const rightState = wrongCallback.searchParams.get("state") ?? "";
    wrongCallback.searchParams.set("state", "not-the-state");
    expectRefused(await followToCallback(test, wrongCallback, wrong.flowCookie));
    wrongCallback.searchParams.set("state", rightState);
    expectRefused(await followToCallback(test, wrongCallback, wrong.flowCookie));

    const used = await startSsoSignIn(test, provider.id);
    const usedCallback = rig.idp.authorize(used.url, identity);
    expect((await followToCallback(test, usedCallback, used.flowCookie)).headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
    expectRefused(await followToCallback(test, usedCallback, used.flowCookie));

    const late = await startSsoSignIn(test, provider.id);
    test.clock.advance(SSO_FLOW_LIFETIME_MS);
    expectRefused(await followToCallback(test, rig.idp.authorize(late.url, identity), late.flowCookie));

    const cookieless = await startSsoSignIn(test, provider.id);
    expectRefused(await followToCallback(test, rig.idp.authorize(cookieless.url, identity), null));
    // Another browser's cookie doesn't fit this state either.
    const other = await startSsoSignIn(test, provider.id);
    expectRefused(await followToCallback(test, rig.idp.authorize(cookieless.url, identity), other.flowCookie));

    expect(ssoFailures()).toEqual(Array.from({ length: 6 }, () => "invalid-flow"));
    expect(test.audited("sign-in.succeeded")).toHaveLength(1);
  });

  it.each<[string, IdTokenTampering]>([
    ["signed by another key", { signWithOtherKey: true }],
    ["from another issuer", { iss: "https://evil.test" }],
    ["for another client", { aud: "someone-else" }],
    ["with another nonce", { nonce: "replayed-nonce" }],
    ["expired", { expiresIn: -120 }],
  ])("refuses an ID token %s", async (_case, tamper) => {
    const user = test.createUser();
    linkTestIdentity(test, user.id, provider, "user-subject");
    rig.idp.tamper = tamper;
    expectRefused(await signInAs(provider, { sub: "user-subject" }));
    expect(test.audited("sign-in.failed")).toMatchObject([
      { details: { method: "sso", providerId: provider.id, reason: "invalid-response" } },
    ]);
    rig.idp.tamper = {};
    expect((await signInAs(provider, { sub: "user-subject" })).headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
  });

  it("refuses the provider's own error answer, and an unknown provider, without telling why", async () => {
    const started = await startSsoSignIn(test, provider.id);
    const callback = rig.idp.authorize(started.url, { sub: "x" });
    callback.searchParams.delete("code");
    callback.searchParams.set("error", "access_denied");
    expectRefused(await followToCallback(test, callback, started.flowCookie));

    const unknown = new URL(`${testOrigin}/api/v1/sso/01900000-0000-7000-8000-000000000000/callback?code=a&state=b`);
    expectRefused(await followToCallback(test, unknown, null));
    const failures = test.audited("sign-in.failed").map((event) => event.details);
    expect(failures).toHaveLength(2);
    expect(failures).toEqual(
      expect.arrayContaining([
        { method: "sso", providerId: null, reason: "unknown-provider" },
        { method: "sso", providerId: provider.id, reason: "provider-error" },
      ]),
    );
  });

  it("builds every redirect URI from PUBLIC_ORIGIN, never from a forged Host", async () => {
    const forged = { host: "evil.example", "x-forwarded-host": "evil2.example" };
    const started = await test.app.inject({
      method: "POST",
      url: routes.startSsoSignIn.path.replace(":id", provider.id),
      headers: { ...sameOriginWrite, ...forged },
    });
    const url = new URL(started.json<{ url: string }>().url);
    expect(url.searchParams.get("redirect_uri")).toBe(`${testOrigin}/api/v1/sso/${provider.id}/callback`);

    await test.createAdmin();
    const cookie = await test.signIn("admin");
    const listed = await test.app.inject({ method: "GET", url: routes.listSsoProviders.path, headers: { ...viaProxy, ...forged, cookie } });
    expect(listed.json()).toMatchObject({ providers: [{ redirectUri: `${testOrigin}/api/v1/sso/${provider.id}/callback` }] });
    expect(listed.body).not.toContain("evil");
  });

  it("signs in with GitHub by its numeric user id, at the fixed issuer, through PKCE", async () => {
    const github = await addTestProvider(test, {
      kind: "github",
      name: "GitHub",
      clientId: "gh-client",
      clientSecret: FAKE_CLIENT_SECRET,
      enabled: true,
    });
    const user = test.createUser();
    linkTestIdentity(test, user.id, github, "4242");

    const started = await startSsoSignIn(test, github.id);
    const authorization = new URL(started.url);
    expect(authorization.origin + authorization.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorization.searchParams.get("scope")).toBe("read:user user:email");
    expect(authorization.searchParams.get("nonce")).toBeNull();
    const callback = rig.github.authorize(started.url, { id: 4242, login: "octo", name: null, emails: [] });
    const response = await followToCallback(test, callback, started.flowCookie);
    expect(response.headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
    expect(rig.github.tokenRequests[0]?.pkceMatched).toBe(true);
    expect(test.services.sso.linkedSignIns.findByIdentity(GITHUB_ISSUER, "4242")).toMatchObject({ accountId: user.id });

    // Another GitHub account with the same login is someone else.
    const stranger = await startSsoSignIn(test, github.id);
    expectRefused(
      await followToCallback(
        test,
        rig.github.authorize(stranger.url, { id: 99, login: "octo", name: null, emails: [] }),
        stranger.flowCookie,
      ),
    );
  });

  it("counts starts and callbacks against the per-IP sign-in limit (T11)", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) await startSsoSignIn(test, provider.id);
    const refused = await callRoute(test, routes.startSsoSignIn, { params: provider.id });
    expectProblem(refused, 429, problemTypes.tooManyAttempts);
    expect(refused.headers["retry-after"]).toBeDefined();
  });

  it("answers 502 sso-provider-unreachable when the provider's discovery times out at the start, keeping no flow", async () => {
    rig.idp.hangDiscovery = true;
    const response = await callRoute(test, routes.startSsoSignIn, { params: provider.id });
    const body = expectProblem(response, 502, problemTypes.ssoProviderUnreachable);
    expect(body.detail).toBe("The provider could not be reached. Try again later.");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(tableRows(test, "sso_flows")).toEqual([]);

    rig.idp.hangDiscovery = false;
    await startSsoSignIn(test, provider.id);
  });

  it("keeps signing in on the provider's last discovery document while it can't be reached for a new one", async () => {
    const user = test.createUser();
    linkTestIdentity(test, user.id, provider, "user-subject");
    await startSsoSignIn(test, provider.id);
    test.clock.advance(61 * 60_000);
    rig.idp.hangDiscovery = true;
    expect((await signInAs(provider, { sub: "user-subject" })).headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
  });

  it("purges flows past their 10 minutes", async () => {
    await startSsoSignIn(test, provider.id);
    test.clock.advance(SSO_FLOW_LIFETIME_MS - 1);
    expect(test.services.sso.flows.purgeExpired()).toBe(0);
    test.clock.advance(1);
    expect(test.services.sso.flows.purgeExpired()).toBe(1);
    expect(tableRows(test, "sso_flows")).toEqual([]);
  });
});

describe("Settings → Linked sign-ins", () => {
  let provider: SsoProvider;
  let user: AccountRecord;
  let cookie: string;

  beforeEach(async () => {
    provider = await addTestProvider(test);
    user = test.createUser();
    cookie = test.startSession(user);
  });

  const link = async (sessionCookie: string, identity: FakeIdentity): Promise<LightMyRequestResponse> => {
    const started = await startTestLink(test, sessionCookie, provider.id);
    return followToCallback(test, rig.idp.authorize(started.url, identity), started.flowCookie);
  };
  const list = async (sessionCookie = cookie) =>
    (await callRoute(test, routes.listLinkedSignIns, { cookie: sessionCookie })).json<LinkedSignIns>();

  it("links an identity, lists it with its email for display, and signs in with it", async () => {
    const linked = await link(cookie, { sub: "new-subject", email: "me@idp.test" });
    expect(linked.statusCode).toBe(303);
    expect(linked.headers.location).toBe(`${LINKED_SIGN_INS_PATH}?linked=${provider.id}`);
    expect(setCookies(linked)).toEqual([CLEARED_SSO_COOKIE]);
    expect(await list()).toEqual({
      linkedSignIns: [
        {
          id: expect.any(String),
          providerId: provider.id,
          providerName: "Test IdP",
          providerKind: "oidc",
          providerEnabled: true,
          email: "me@idp.test",
          createdAt: test.clock.now().toISOString(),
          lastUsedAt: null,
          removable: false,
        },
      ],
    });
    expect(test.audited("linked-sign-in.added")).toMatchObject([
      { actorAccountId: user.id, targetId: user.id, details: { providerId: provider.id, kind: "oidc" } },
    ]);
    expect((await signInAs(provider, { sub: "new-subject" })).headers.location).toBe(SSO_SIGN_IN_COMPLETE_PATH);
  });

  it("needs a recent sign-in to link or unlink", async () => {
    const id = linkTestIdentity(test, user.id, provider, "one");
    linkTestIdentity(test, user.id, provider, "two");
    const stale = test.startSession(user, { recentSignIn: false });
    expectProblem(
      await callRoute(test, routes.startLink, { cookie: stale, payload: { providerId: provider.id } }),
      403,
      problemTypes.recentSignInRequired,
    );
    expectProblem(await callRoute(test, routes.unlink, { cookie: stale, params: id }), 403, problemTypes.recentSignInRequired);
    expect((await list(stale)).linkedSignIns).toHaveLength(2);
  });

  it("refuses an identity linked to any account already, this one included", async () => {
    const other = test.createUser({ username: "other" });
    linkTestIdentity(test, other.id, provider, "taken");
    const failure = `${LINKED_SIGN_INS_PATH}?error=identity-already-linked`;
    expect((await link(cookie, { sub: "taken" })).headers.location).toBe(failure);
    expect((await link(cookie, { sub: "mine" })).headers.location).toBe(`${LINKED_SIGN_INS_PATH}?linked=${provider.id}`);
    expect((await link(cookie, { sub: "mine" })).headers.location).toBe(failure);
    expect((await list()).linkedSignIns).toHaveLength(1);
  });

  it("answers 502 sso-provider-unreachable when the provider's discovery times out at the start of a link", async () => {
    rig.idp.hangDiscovery = true;
    expectProblem(
      await callRoute(test, routes.startLink, { cookie, payload: { providerId: provider.id } }),
      502,
      problemTypes.ssoProviderUnreachable,
    );
    expect(tableRows(test, "sso_flows")).toEqual([]);
  });

  it("refuses a link whose session ended before the callback", async () => {
    const started = await startTestLink(test, cookie, provider.id);
    await callRoute(test, routes.signOut, { cookie });
    const response = await followToCallback(test, rig.idp.authorize(started.url, { sub: "late" }), started.flowCookie);
    expect(response.headers.location).toBe(`${LINKED_SIGN_INS_PATH}?error=link-failed`);
    expect(tableRows(test, "linked_sign_ins")).toEqual([]);
  });

  it("refuses unlinking a user's last sign-in, while the admin may unlink its only one", async () => {
    const first = linkTestIdentity(test, user.id, provider, "one");
    const second = linkTestIdentity(test, user.id, provider, "two");
    expect((await list()).linkedSignIns.map((entry) => entry.removable)).toEqual([true, true]);
    expect((await callRoute(test, routes.unlink, { cookie, params: first })).statusCode).toBe(204);
    expect((await list()).linkedSignIns).toMatchObject([{ id: second, removable: false }]);
    expectProblem(await callRoute(test, routes.unlink, { cookie, params: second }), 409, problemTypes.lastSignInMethod);
    expectProblem(await callRoute(test, routes.unlink, { cookie, params: first }), 404, problemTypes.notFound);

    const admin = await test.createAdmin();
    const adminCookie = test.startSession(admin);
    const only = linkTestIdentity(test, admin.id, provider, "admin");
    expect((await list(adminCookie)).linkedSignIns).toMatchObject([{ id: only, removable: true }]);
    expect((await callRoute(test, routes.unlink, { cookie: adminCookie, params: only })).statusCode).toBe(204);
    const removed = test.audited("linked-sign-in.removed").map((event) => [event.targetId, event.details["linkedSignInId"]]);
    expect(removed).toHaveLength(2);
    expect(removed).toEqual(
      expect.arrayContaining([
        [admin.id, only],
        [user.id, first],
      ]),
    );
  });

  it("stores the primary verified GitHub email for display", async () => {
    const github = await addTestProvider(test, {
      kind: "github",
      name: "GitHub",
      clientId: "gh",
      clientSecret: FAKE_CLIENT_SECRET,
      enabled: true,
    });
    const started = await startTestLink(test, cookie, github.id);
    const callback = rig.github.authorize(started.url, {
      id: 7,
      login: "octo",
      name: "Octo Cat",
      emails: [
        { email: "unverified@example.com", primary: true, verified: false },
        { email: "other@example.com", primary: false, verified: true },
      ],
    });
    expect((await followToCallback(test, callback, started.flowCookie)).headers.location).toBe(
      `${LINKED_SIGN_INS_PATH}?linked=${github.id}`,
    );
    expect((await list()).linkedSignIns).toMatchObject([{ providerKind: "github", email: null }]);
    expect(tableRows(test, "linked_sign_ins")).toMatchObject([{ issuer: GITHUB_ISSUER, subject: "7" }]);
  });
});

describe("SSO secrets at rest (threat model, T6)", () => {
  it("are re-encrypted by rotate-key", async () => {
    const provider = await addTestProvider(test);
    await startSsoSignIn(test, provider.id);
    const newKey = Buffer.alloc(32, 9);
    const rotated = rotateMasterKey({ database: test.database, oldKey: Buffer.alloc(32, 7), newKey, columns: envelopeColumns });
    expect(rotated).toContainEqual({ table: "sso_providers", column: "client_secret", reencrypted: 1 });
    expect(rotated).toContainEqual({ table: "sso_flows", column: "code_verifier", reencrypted: 1 });

    const [row] = tableRows(test, "sso_providers");
    const aad = { table: "sso_providers", column: "client_secret", rowId: provider.id };
    expect(createSecrets(newKey).decrypt("sso", aad, String(row?.["client_secret"]))).toBe(FAKE_CLIENT_SECRET);
    expect(() => testSecrets.decrypt("sso", aad, String(row?.["client_secret"]))).toThrow(SecretDecryptionError);
  });
});
