import { problemTypes, type Reauthentication } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpProblem, type Caller } from "../../http/index.ts";
import { addPasskeyInSettings, buildTestApp, createSoftwarePasskey, goodPassword, type TestApp } from "../../test-support/index.ts";
import type { AccountRecord } from "../accounts/index.ts";

const origin = { ip: "203.0.113.7", userAgent: "reauthenticate-test" };

/** The problem `work` fails with, as `status type`. */
async function problemOf(work: Promise<unknown>): Promise<string> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof HttpProblem)) throw new Error(`Expected an HttpProblem, got ${String(error)}`);
  return `${error.status} ${error.type}`;
}

describe("reauthenticating with both factors", () => {
  let test: TestApp;
  let admin: AccountRecord;
  let cookie: string;
  let caller: Caller;
  let token: string;

  beforeEach(async () => {
    test = await buildTestApp();
    admin = await test.createAdmin();
    // Enrols an authenticator app at the second step.
    cookie = await test.signIn(admin.username);
    const started = test.services.sessions.start({ account: admin, state: "active", recentSignIn: false, origin });
    const { session } = started;
    token = started.token;
    caller = { accountId: admin.id, username: admin.username, role: "admin", sessionId: session.id, state: "active", recentSignInAt: null };
  });
  afterEach(() => test.close());

  const reauthenticate = (password: string, secondFactor: Reauthentication["secondFactor"]) =>
    test.services.signIn.reauthenticate(caller, { password, secondFactor }, origin);

  it("passes the password and a code, without rotating the session or renewing its recent sign-in", async () => {
    await expect(reauthenticate(goodPassword, { code: test.totpCode(admin.id) })).resolves.toBeUndefined();
    expect(test.services.sessions.resolve(token)).toMatchObject({ id: caller.sessionId, recentSignInAt: null });
  });

  it("checks the password first, and the code only once it passed", async () => {
    expect(await problemOf(reauthenticate("not the password", { code: test.totpCode(admin.id) }))).toBe(`401 ${problemTypes.signInFailed}`);
    expect(test.audited("sign-in.failed")).toMatchObject([{ ip: origin.ip, details: { method: "password", reason: "wrong-password" } }]);
    expect(test.audited("second-factor.failed")).toEqual([]);

    expect(await problemOf(reauthenticate(goodPassword, { code: "000000" }))).toBe(`401 ${problemTypes.secondFactorFailed}`);
    expect(test.audited("second-factor.failed")).toMatchObject([{ details: { method: "totp", during: "confirm", limitReached: false } }]);
  });

  it("refuses a code used already, as confirm does", async () => {
    const code = test.totpCode(admin.id);
    await reauthenticate(goodPassword, { code });
    expect(await problemOf(reauthenticate(goodPassword, { code }))).toBe(`401 ${problemTypes.secondFactorFailed}`);
  });

  it("answers 429 past the second-factor try limits", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await problemOf(reauthenticate(goodPassword, { code: "000000" }))).toBe(`401 ${problemTypes.secondFactorFailed}`);
      // Past the per-IP sign-in limit's minute, so only the second factor's limits count.
      test.clock.advance(61_000);
    }
    expect(await problemOf(reauthenticate(goodPassword, { code: test.totpCode(admin.id) }))).toBe(`429 ${problemTypes.tooManyAttempts}`);
  });

  it("takes a passkey over the confirm challenge", async () => {
    const phone = createSoftwarePasskey();
    await addPasskeyInSettings(test, cookie, phone);
    const options = async () => test.services.signIn.passkeyConfirmationOptions(caller);
    await expect(reauthenticate(goodPassword, { passkey: phone.assert(await options()) })).resolves.toBeUndefined();
    // A challenge is used once.
    const used = await options();
    await reauthenticate(goodPassword, { passkey: phone.assert(used) });
    expect(await problemOf(reauthenticate(goodPassword, { passkey: phone.assert(used) }))).toBe(`401 ${problemTypes.secondFactorFailed}`);
  });
});
