import {
  problemTypes,
  routes,
  type Passkey,
  type PasskeyCreationOptions,
  type PasskeyRequestOptions,
  type Session,
  type SecondFactorStep,
} from "@not-unreachable/contracts";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_SIGN_IN_MS } from "../../http/index.ts";
import {
  buildTestApp,
  createSoftwarePasskey,
  enrolPasskeyAtSignIn,
  expectProblem,
  goodPassword,
  sameOriginWrite,
  sessionCookieHeader,
  sessionTokenFrom,
  type CeremonyOverrides,
  type SoftwarePasskey,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import { users, type AccountRecord } from "../accounts/index.ts";
import { WEBAUTHN_CHALLENGE_LIFETIME_MS } from "../second-factors/index.ts";
import { WEBAUTHN_COOKIE } from "./webauthn-cookie.ts";

let test: TestApp;
let admin: AccountRecord;
let phone: SoftwarePasskey;

beforeEach(async () => {
  test = await buildTestApp();
  admin = await test.createAdmin({ username: "root.admin" });
  phone = createSoftwarePasskey();
});
afterEach(() => test.close());

const cookieOf = (response: LightMyRequestResponse): string => sessionCookieHeader(sessionTokenFrom(response));
const pending = async (): Promise<string> => (await test.signInWithPassword("root.admin")).cookie;
const setCookies = (response: LightMyRequestResponse): string[] => {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header === undefined ? [] : [header];
};

/** Enrols `phone` at the password sign-in's step; answers the active session's cookie. */
async function enrolPhone(): Promise<string> {
  const cookie = await pending();
  await enrolPasskeyAtSignIn(test, cookie, phone);
  return cookieOf(await callRoute(test, routes.acknowledgeRecoveryCodes, { cookie }));
}

const secondStepOptions = async (cookie: string): Promise<PasskeyRequestOptions> => {
  const response = await callRoute(test, routes.startPasskeySecondFactor, { cookie });
  expect(response.statusCode).toBe(200);
  return response.json<PasskeyRequestOptions>();
};
const passPasskey = (cookie: string, response: object) => callRoute(test, routes.passPasskey, { cookie, payload: { response } });
/** Options, then the passkey's assertion over them, at a pending session's second step. */
const secondStep = async (cookie: string, overrides: CeremonyOverrides = {}, passkey = phone) =>
  passPasskey(cookie, passkey.assert(await secondStepOptions(cookie), overrides));

/** Creation options naming `accountId`, for a passkey made outside this site. */
const registrationOptionsFor = (accountId: string): PasskeyCreationOptions => ({
  rp: { id: "files.example.com", name: "NotUnreachable" },
  user: { id: Buffer.from(accountId).toString("base64url"), name: "root.admin", displayName: "Root" },
  challenge: "AAAA",
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
});

const IP = "203.0.113.9";

/** Passwordless: the options and the browser's `__Host-nu_webauthn` token. */
async function passwordlessOptions(
  ip = IP,
): Promise<{ options: PasskeyRequestOptions; browser: string; response: LightMyRequestResponse }> {
  const response = await test.app.inject({
    method: "POST",
    url: routes.startPasskeySignIn.path,
    headers: { ...sameOriginWrite, "x-forwarded-for": ip },
  });
  expect(response.statusCode).toBe(200);
  const token = setCookies(response)
    .map((value) => new RegExp(`^${WEBAUTHN_COOKIE}=([A-Za-z0-9_-]{43});`).exec(value)?.[1])
    .find((found) => found !== undefined);
  if (token === undefined) throw new Error("No webauthn cookie");
  return { options: response.json<PasskeyRequestOptions>(), browser: `${WEBAUTHN_COOKIE}=${token}`, response };
}

const passwordlessVerify = (browser: string | undefined, response: object, ip = IP) =>
  test.app.inject({
    method: "POST",
    url: routes.passkeySignIn.path,
    headers: { ...sameOriginWrite, "x-forwarded-for": ip, ...(browser === undefined ? {} : { cookie: browser }) },
    payload: { response },
  });

/** A whole passwordless sign-in with `passkey`'s assertion, changed by `overrides`. */
async function passwordless(overrides: CeremonyOverrides = {}, passkey = phone, ip = IP): Promise<LightMyRequestResponse> {
  const { options, browser } = await passwordlessOptions(ip);
  return passwordlessVerify(browser, passkey.assert(options, overrides), ip);
}

const passkeyFailureReasons = () =>
  test
    .audited("sign-in.failed")
    .filter((event) => event.details["method"] === "passkey")
    .map((event) => event.details["reason"]);

describe("enrolling a passkey at the forced second step", () => {
  it("adds a passkey instead of an authenticator app, gives recovery codes, and activates once they are acknowledged", async () => {
    const cookie = await pending();
    expect((await callRoute(test, routes.getSecondFactorStep, { cookie })).json()).toEqual({ mode: "enrol", methods: [] });
    const recoveryCodes = await enrolPasskeyAtSignIn(test, cookie, phone);
    expect(recoveryCodes).toHaveLength(10);
    // Still pending until the codes are saved.
    expectProblem(await callRoute(test, routes.getProfile, { cookie }), 403, problemTypes.forbidden);

    const acknowledged = await callRoute(test, routes.acknowledgeRecoveryCodes, { cookie });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({
      state: "active",
      recentSignInUntil: new Date(test.clock.now().getTime() + RECENT_SIGN_IN_MS).toISOString(),
    });
    const active = cookieOf(acknowledged);
    expect((await callRoute(test, routes.getProfile, { cookie: active })).statusCode).toBe(200);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
    expect(tableRows(test, "totp_credentials")).toEqual([]);
    expect(test.audited("second-factor.added")).toMatchObject([{ actorAccountId: admin.id, details: { kind: "passkey" } }]);
    expect(test.audited("sign-in.succeeded")).toMatchObject([{ details: { method: "password", secondFactor: "passkey" } }]);
  });

  it("refuses a passkey enrolment that doesn't pass, counted like a wrong code, and any once a factor exists", async () => {
    const cookie = await pending();
    const unverified = createSoftwarePasskey({ userVerified: false });
    const enrolOptions = (await callRoute(test, routes.startPasskeyEnrolment, { cookie })).json<never>();
    expectProblem(
      await callRoute(test, routes.confirmPasskeyEnrolment, {
        cookie,
        payload: { name: "Phone", response: unverified.register(enrolOptions) },
      }),
      401,
      problemTypes.secondFactorFailed,
    );
    expect(test.audited("second-factor.failed")).toMatchObject([
      { details: { method: "passkey", during: "enrolment", limitReached: false } },
    ]);

    await enrolPasskeyAtSignIn(test, cookie, phone);
    await callRoute(test, routes.acknowledgeRecoveryCodes, { cookie });
    const next = await pending();
    expect((await callRoute(test, routes.getSecondFactorStep, { cookie: next })).json<SecondFactorStep>()).toEqual({
      mode: "verify",
      methods: ["passkey", "recoveryCode"],
    });
    for (const route of [routes.startPasskeyEnrolment, routes.startTotpEnrolment, routes.acknowledgeRecoveryCodes]) {
      expectProblem(await callRoute(test, route, { cookie: next }), 409, problemTypes.secondFactorExists);
    }
    expectProblem(
      await callRoute(test, routes.confirmPasskeyEnrolment, {
        cookie: next,
        payload: { name: "Key", response: createSoftwarePasskey().register(enrolOptions) },
      }),
      409,
      problemTypes.secondFactorExists,
    );
    expect(tableRows(test, "passkey_credentials")).toHaveLength(1);
  });
});

describe("the passkey at the second step (threat model, T10)", () => {
  beforeEach(enrolPhone);

  it("makes the pending session active with a new token, and records the use", async () => {
    const cookie = await pending();
    const options = await secondStepOptions(cookie);
    expect(options).toMatchObject({
      rpId: "files.example.com",
      allowCredentials: [{ id: phone.credentialId, type: "public-key" }],
      userVerification: "preferred",
    });
    test.clock.advance(1000);
    const passed = await passPasskey(cookie, phone.assert(options));
    expect(passed.statusCode).toBe(200);
    expect(passed.json<Session>()).toMatchObject({ state: "active", account: { id: admin.id } });
    const active = cookieOf(passed);
    expect(active).not.toBe(cookie);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
    expect((await callRoute(test, routes.getProfile, { cookie: active })).statusCode).toBe(200);

    const [listed] = (await callRoute(test, routes.listPasskeys, { cookie: active })).json<{ passkeys: Passkey[] }>().passkeys;
    expect(listed?.lastUsedAt).toBe(test.clock.now().toISOString());
    expect(test.audited("sign-in.succeeded")[0]).toMatchObject({ details: { method: "password", secondFactor: "passkey" } });
  });

  it("refuses another account's passkey, another origin or RP ID, and a challenge used or never issued", async () => {
    const cookie = await pending();
    expectProblem(await secondStep(cookie, { origin: "https://files.example.com:8443" }), 401, problemTypes.secondFactorFailed);
    expectProblem(await secondStep(cookie, { rpId: "example.com" }), 401, problemTypes.secondFactorFailed);
    expectProblem(await secondStep(cookie, {}, createSoftwarePasskey()), 401, problemTypes.secondFactorFailed);

    // A challenge is used once, even by an answer that failed.
    const options = await secondStepOptions(cookie);
    expectProblem(
      await passPasskey(cookie, phone.assert(options, { origin: "https://evil.example.com" })),
      401,
      problemTypes.secondFactorFailed,
    );
    expect((await callRoute(test, routes.getSession, { cookie })).json()).toMatchObject({ state: "pendingSecondFactor" });
    const another = await pending();
    expectProblem(await passPasskey(another, phone.assert(options)), 401, problemTypes.secondFactorFailed);
    expect((await secondStep(another)).statusCode).toBe(200);
    expect(test.audited("second-factor.failed").map((event) => event.details["method"])).toEqual(Array(5).fill("passkey"));
  });

  it("revokes the pending session at the 5th failure within 15 minutes, as for codes", async () => {
    const cookie = await pending();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expectProblem(await secondStep(cookie, { rpId: "example.com" }), 401, problemTypes.secondFactorFailed);
    }
    expectProblem(await secondStep(cookie, { rpId: "example.com" }), 429, problemTypes.tooManyAttempts);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
    const failures = test.audited("second-factor.failed");
    expect(failures).toHaveLength(5);
    expect(failures.filter((failure) => failure.details["limitReached"] === true)).toMatchObject([
      { details: { method: "passkey", during: "sign-in", limitReached: true } },
    ]);
    expect(test.audited("session.revoked")).toMatchObject([{ details: { reason: "second-factor-limit" } }]);
  });

  it("refuses a counter that doesn't increase, audited as such", async () => {
    expect((await secondStep(await pending(), { counter: 5 })).statusCode).toBe(200);
    const cookie = await pending();
    expectProblem(await secondStep(cookie, { counter: 5 }), 401, problemTypes.secondFactorFailed);
    expectProblem(await secondStep(cookie, { counter: 3 }), 401, problemTypes.secondFactorFailed);
    expect(test.audited("second-factor.failed")).toMatchObject([
      { details: { method: "passkey", during: "sign-in", reason: "counter" } },
      { details: { method: "passkey", during: "sign-in", reason: "counter" } },
    ]);
    expect(tableRows(test, "passkey_credentials")).toMatchObject([{ counter: 5 }]);
    expect((await secondStep(cookie, { counter: 6 })).statusCode).toBe(200);
  });

  it("passes again and again for an authenticator that keeps no counter (always 0)", async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) expect((await secondStep(await pending(), { counter: 0 })).statusCode).toBe(200);
  });
});

describe("passwordless sign-in with a passkey", () => {
  beforeEach(enrolPhone);

  it("makes an active session with a recent sign-in at once, bound to the browser's cookie", async () => {
    const { options, browser, response } = await passwordlessOptions();
    expect(options).toMatchObject({ rpId: "files.example.com", allowCredentials: [], userVerification: "required" });
    expect(setCookies(response)).toEqual([
      expect.stringMatching(/^__Host-nu_webauthn=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300$/),
    ]);

    const signedIn = await passwordlessVerify(browser, phone.assert(options));
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual({
      account: expect.objectContaining({ id: admin.id }),
      state: "active",
      recentSignInUntil: new Date(test.clock.now().getTime() + RECENT_SIGN_IN_MS).toISOString(),
    });
    expect(setCookies(signedIn)).toEqual([
      `${WEBAUTHN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
      expect.stringMatching(/^__Host-nu_session=/),
    ]);
    const cookie = cookieOf(signedIn);
    // A recent sign-in: routes that need one pass at once.
    expect((await callRoute(test, routes.regenerateRecoveryCodes, { cookie })).statusCode).toBe(200);
    expect(tableRows(test, "sessions").find((row) => row["state"] === "active" && row["sign_in_method"] === "passkey")).toBeDefined();
    expect(test.audited("sign-in.succeeded").filter((event) => event.details["method"] === "passkey")).toMatchObject([
      {
        actorKind: "account",
        actorAccountId: admin.id,
        targetId: admin.id,
        ip: IP,
        details: { method: "passkey", secondFactor: null },
      },
    ]);
  });

  it("ends the browser's earlier session", async () => {
    const earlier = await pending();
    const { options, browser } = await passwordlessOptions();
    const signedIn = await test.app.inject({
      method: "POST",
      url: routes.passkeySignIn.path,
      headers: { ...sameOriginWrite, cookie: `${earlier}; ${browser}` },
      payload: { response: phone.assert(options) },
    });
    expect(signedIn.statusCode).toBe(200);
    expectProblem(await callRoute(test, routes.getSession, { cookie: earlier }), 401, problemTypes.signInRequired);
  });

  it("answers every failure exactly as a failed password sign-in, clearing the cookie, and audits why", async () => {
    const password = await test.app.inject({
      method: "POST",
      url: routes.signIn.path,
      headers: sameOriginWrite,
      payload: { identifier: "root.admin", password: "wrong password" },
    });
    const failedSignIn = { status: password.statusCode, body: password.body };
    expect(failedSignIn.status).toBe(401);

    // A passkey this site never saved, claiming to be the admin's.
    const stranger = createSoftwarePasskey();
    stranger.register(registrationOptionsFor(admin.id));
    const { options, browser } = await passwordlessOptions();
    const other = await passwordlessOptions();

    const failures: LightMyRequestResponse[] = [
      await passwordless({}, stranger),
      await passwordless({ userVerified: false }),
      await passwordless({ userHandle: Buffer.from("someone else").toString("base64url") }),
      await passwordless({ userHandle: null }),
      await passwordless({ origin: "https://evil.example.com" }),
      await passwordless({ rpId: "example.com" }),
      // No cookie; another browser's, whose own challenge the assertion doesn't sign.
      await passwordlessVerify(undefined, phone.assert(options)),
      await passwordlessVerify(other.browser, phone.assert(options)),
    ];
    for (const failure of failures) {
      expect({ status: failure.statusCode, body: failure.body }).toEqual(failedSignIn);
      expect(setCookies(failure)).toEqual([`${WEBAUTHN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`]);
    }
    // Events of one millisecond come in no set order.
    expect(passkeyFailureReasons()).toHaveLength(8);
    expect(passkeyFailureReasons()).toEqual(
      expect.arrayContaining(["unknown-passkey", "not-verified", "user-handle-mismatch", "invalid-challenge"]),
    );
    expect(passkeyFailureReasons().filter((reason) => reason === "not-verified")).toHaveLength(4);
    expect(passkeyFailureReasons().filter((reason) => reason === "user-handle-mismatch")).toHaveLength(2);
    expect(test.audited("sign-in.failed").filter((event) => event.details["method"] === "passkey")).toEqual(
      Array.from({ length: 8 }, () => expect.objectContaining({ actorKind: "anonymous", outcome: "failed", ip: IP })),
    );
    // A failure uses the browser's challenge up: the right answer can't pass with it any more.
    expect((await passwordlessVerify(browser, phone.assert(options, { origin: "https://evil.example.com" }))).statusCode).toBe(401);
    expect((await passwordlessVerify(browser, phone.assert(options))).statusCode).toBe(401);
    expect(test.audited("sign-in.succeeded").filter((event) => event.details["method"] === "passkey")).toEqual([]);
  });

  it("refuses a disabled account's passkey", async () => {
    test.database.db.update(users).set({ status: "disabled" }).where(eq(users.id, admin.id)).run();
    expectProblem(await passwordless(), 401, problemTypes.signInFailed);
    expect(passkeyFailureReasons()).toEqual(["disabled"]);
  });

  it("uses a challenge once and voids it after 5 minutes", async () => {
    const { options, browser } = await passwordlessOptions();
    const assertion = phone.assert(options);
    expect((await passwordlessVerify(browser, assertion)).statusCode).toBe(200);
    expectProblem(await passwordlessVerify(browser, assertion), 401, problemTypes.signInFailed);

    const late = await passwordlessOptions();
    test.clock.advance(WEBAUTHN_CHALLENGE_LIFETIME_MS - 1);
    const almost = await passwordlessOptions();
    test.clock.advance(1);
    expectProblem(await passwordlessVerify(late.browser, phone.assert(late.options)), 401, problemTypes.signInFailed);
    expect((await passwordlessVerify(almost.browser, phone.assert(almost.options))).statusCode).toBe(200);
    expect(passkeyFailureReasons()).toEqual(["invalid-challenge", "invalid-challenge"]);
  });

  it("refuses a counter that doesn't increase, audited as such", async () => {
    expect((await passwordless({ counter: 7 })).statusCode).toBe(200);
    expectProblem(await passwordless({ counter: 7 }), 401, problemTypes.signInFailed);
    expect(passkeyFailureReasons()).toEqual(["counter"]);
    expect(test.audited("second-factor.failed")).toMatchObject([
      { targetId: admin.id, details: { method: "passkey", during: "sign-in", limitReached: false, reason: "counter" } },
    ]);
    expect((await passwordless({ counter: 8 })).statusCode).toBe(200);
  });

  it("counts its attempts toward the per-IP sign-in limit (threat model, T11)", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await passwordless({ userVerified: false })).statusCode).toBe(401);
    }
    const refused = await passwordless();
    expectProblem(refused, 429, problemTypes.tooManyAttempts);
    expect(refused.headers["retry-after"]).toBe("60");
    const password = await test.app.inject({
      method: "POST",
      url: routes.signIn.path,
      headers: { ...sameOriginWrite, "x-forwarded-for": IP },
      payload: { identifier: "root.admin", password: goodPassword },
    });
    expectProblem(password, 429, problemTypes.tooManyAttempts);
    expect((await passwordless({}, phone, "203.0.113.10")).statusCode).toBe(200);
  });
});

describe("renewing the recent sign-in with a passkey", () => {
  it("accepts an assertion over the session's confirm challenge and rotates the token", async () => {
    const cookie = await enrolPhone();
    test.clock.advance(RECENT_SIGN_IN_MS);
    expectProblem(await callRoute(test, routes.regenerateRecoveryCodes, { cookie }), 403, problemTypes.recentSignInRequired);

    const confirm = async (overrides: CeremonyOverrides = {}) => {
      const options = await callRoute(test, routes.startPasskeyConfirmation, { cookie });
      expect(options.statusCode).toBe(200);
      const requestOptions = options.json<PasskeyRequestOptions>();
      expect(requestOptions.allowCredentials).toEqual([{ id: phone.credentialId, type: "public-key", transports: ["internal", "hybrid"] }]);
      return callRoute(test, routes.confirmSession, { cookie, payload: { passkey: phone.assert(requestOptions, overrides) } });
    };

    expectProblem(await confirm({ origin: "https://evil.example.com" }), 401, problemTypes.secondFactorFailed);
    expect(test.audited("second-factor.failed")).toMatchObject([
      { details: { method: "passkey", during: "confirm", limitReached: false } },
    ]);
    // A second-step challenge isn't a confirm one.
    expectProblem(
      await callRoute(test, routes.confirmSession, { cookie, payload: { passkey: phone.assert({ challenge: "AAAA" }) } }),
      401,
      problemTypes.secondFactorFailed,
    );

    const confirmed = await confirm();
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      state: "active",
      recentSignInUntil: new Date(test.clock.now().getTime() + RECENT_SIGN_IN_MS).toISOString(),
    });
    const rotated = cookieOf(confirmed);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
    expect((await callRoute(test, routes.regenerateRecoveryCodes, { cookie: rotated })).statusCode).toBe(200);
  });

  it("is open to a user's session too, which has no passkeys to list", async () => {
    const cookie = test.startSession(test.createUser());
    const options = await callRoute(test, routes.startPasskeyConfirmation, { cookie });
    expect(options.statusCode).toBe(200);
    expect(options.json<PasskeyRequestOptions>().allowCredentials).toEqual([]);
  });
});

describe("the relying party under a forged Host (threat model, T15)", () => {
  const forged = { host: "evil.example", "x-forwarded-host": "evil2.example" };

  it("takes the RP ID and the expected origin from PUBLIC_ORIGIN only", async () => {
    const cookie = await enrolPhone();
    const registration = await test.app.inject({
      method: "POST",
      url: routes.startPasskeyRegistration.path,
      headers: { ...sameOriginWrite, ...forged, cookie },
    });
    expect(registration.json<PasskeyCreationOptions>().rp.id).toBe("files.example.com");

    const startForged = async () => {
      const started = await test.app.inject({
        method: "POST",
        url: routes.startPasskeySignIn.path,
        headers: { ...sameOriginWrite, ...forged },
      });
      const token = setCookies(started)
        .map((value) => new RegExp(`^${WEBAUTHN_COOKIE}=([A-Za-z0-9_-]{43});`).exec(value)?.[1])
        .find((found) => found !== undefined);
      return { options: started.json<PasskeyRequestOptions>(), browser: `${WEBAUTHN_COOKIE}=${String(token)}` };
    };
    const verifyForged = (browser: string, response: object) =>
      test.app.inject({
        method: "POST",
        url: routes.passkeySignIn.path,
        headers: { ...sameOriginWrite, ...forged, cookie: browser },
        payload: { response },
      });

    const first = await startForged();
    expect(first.options.rpId).toBe("files.example.com");
    // An assertion made for the forged host is refused...
    const forHost = phone.assert(first.options, { origin: "https://evil.example", rpId: "evil.example" });
    expectProblem(await verifyForged(first.browser, forHost), 401, problemTypes.signInFailed);
    // ...and one made for PUBLIC_ORIGIN passes, whatever the Host says.
    const second = await startForged();
    expect((await verifyForged(second.browser, phone.assert(second.options))).statusCode).toBe(200);
  });
});
