import {
  problemTypes,
  routes,
  type AddedPasskey,
  type Passkey,
  type PasskeyCreationOptions,
  type SecondFactors,
} from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_SIGN_IN_MS } from "../../http/index.ts";
import {
  addPasskeyInSettings,
  buildTestApp,
  createSoftwarePasskey,
  enrolPasskeyAtSignIn,
  expectProblem,
  sessionCookieHeader,
  sessionTokenFrom,
  testOrigin,
  type CeremonyOverrides,
  type SoftwarePasskey,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { WEBAUTHN_CHALLENGE_LIFETIME_MS } from "./index.ts";

let test: TestApp;
let admin: AccountRecord;

beforeEach(async () => {
  test = await buildTestApp();
  admin = await test.createAdmin({ username: "root.admin" });
});
afterEach(() => test.close());

const passkeys = async (cookie: string): Promise<Passkey[]> =>
  (await callRoute(test, routes.listPasskeys, { cookie })).json<{ passkeys: Passkey[] }>().passkeys;
const registrationOptions = async (cookie: string): Promise<PasskeyCreationOptions> => {
  const response = await callRoute(test, routes.startPasskeyRegistration, { cookie });
  expect(response.statusCode).toBe(200);
  return response.json<PasskeyCreationOptions>();
};
const addPasskey = (cookie: string, name: string, response: object) =>
  callRoute(test, routes.addPasskey, { cookie, payload: { name, response } });

/** An active session whose admin passed the second step with an authenticator app. */
const withTotp = (): Promise<string> => test.signIn("root.admin");

/** An active session whose admin enrolled only a passkey at sign-in. */
async function withOnlyPasskey(passkey: SoftwarePasskey): Promise<string> {
  const { cookie } = await test.signInWithPassword("root.admin");
  await enrolPasskeyAtSignIn(test, cookie, passkey);
  return sessionCookieHeader(sessionTokenFrom(await callRoute(test, routes.acknowledgeRecoveryCodes, { cookie })));
}

describe("Settings → Two-step sign-in → Passkeys", () => {
  it("adds a passkey, lists it with the other factors, renames it, and excludes it from the next registration", async () => {
    const cookie = await withTotp();
    const phone = createSoftwarePasskey();
    const options = await registrationOptions(cookie);
    expect(options).toMatchObject({
      rp: { id: new URL(testOrigin).hostname, name: "NotUnreachable" },
      user: { id: Buffer.from(admin.id).toString("base64url"), name: "root.admin" },
      excludeCredentials: [],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
    });

    const added = await addPasskey(cookie, "  Phone  ", phone.register(options));
    expect(added.statusCode).toBe(200);
    const now = test.clock.now().toISOString();
    const passkey = { id: expect.any(String), name: "Phone", synced: false, createdAt: now, lastUsedAt: null };
    // The admin has recovery codes from the authenticator app already.
    expect(added.json<AddedPasskey>()).toEqual({ passkey, recoveryCodes: null });
    expect(await passkeys(cookie)).toEqual([passkey]);
    const factors = (await callRoute(test, routes.getSecondFactors, { cookie })).json<SecondFactors>();
    expect(factors.factors.map((factor) => factor.kind).toSorted()).toEqual(["passkey", "totp"]);
    expect(test.audited("second-factor.added").map((event) => event.details)).toContainEqual({ kind: "passkey" });

    const { id } = added.json<AddedPasskey>().passkey;
    const renamed = await callRoute(test, routes.renamePasskey, { cookie, params: id, payload: { name: " Work phone " } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ ...passkey, id, name: "Work phone" });
    expect((await passkeys(cookie)).map((row) => row.name)).toEqual(["Work phone"]);
    expectProblem(await callRoute(test, routes.renamePasskey, { cookie, payload: { name: "Other" } }), 404, problemTypes.notFound);
    expectProblem(
      await callRoute(test, routes.renamePasskey, { cookie, params: id, payload: { name: "  " } }),
      400,
      problemTypes.validationFailed,
    );

    const next = await registrationOptions(cookie);
    expect(next.excludeCredentials).toEqual([{ id: phone.credentialId, type: "public-key", transports: ["internal", "hybrid"] }]);
    // The same authenticator can't be added twice.
    expectProblem(await addPasskey(cookie, "Again", phone.register(next)), 422, problemTypes.secondFactorFailed);
    expect(await passkeys(cookie)).toHaveLength(1);
  });

  it("marks a backed-up passkey as synced and never answers or audits its public key or credential id", async () => {
    const cookie = await withTotp();
    const synced = createSoftwarePasskey({ backedUp: true });
    const { passkey } = await addPasskeyInSettings(test, cookie, synced, "Password manager");
    expect(passkey).toMatchObject({ name: "Password manager", synced: true });
    const [row] = tableRows(test, "passkey_credentials");
    expect(row).toMatchObject({ credential_id: synced.credentialId, backed_up: 1, counter: 0 });
    const answers = [
      await callRoute(test, routes.listPasskeys, { cookie }),
      await callRoute(test, routes.getSecondFactors, { cookie }),
      await callRoute(test, routes.listAuditEvents, { cookie }),
    ];
    for (const answer of answers) expect(answer.body).not.toContain(synced.credentialId);
  });

  it("gives the first recovery codes with a passkey when the account has none", async () => {
    // An active session of an admin with no factor yet, started straight through the service.
    const cookie = test.startSession(admin);
    const added = await addPasskeyInSettings(test, cookie, createSoftwarePasskey());
    expect(added.recoveryCodes).toHaveLength(10);
    expect(tableRows(test, "recovery_codes")).toHaveLength(10);
    // A second passkey leaves them alone.
    expect((await addPasskeyInSettings(test, cookie, createSoftwarePasskey(), "Key")).recoveryCodes).toBeNull();
    expect(tableRows(test, "recovery_codes")).toHaveLength(10);
  });

  it("needs a recent sign-in to add or remove a passkey, not to list or rename one", async () => {
    const cookie = await withTotp();
    const { passkey } = await addPasskeyInSettings(test, cookie, createSoftwarePasskey());
    const options = await registrationOptions(cookie);
    test.clock.advance(RECENT_SIGN_IN_MS);

    expectProblem(await callRoute(test, routes.startPasskeyRegistration, { cookie }), 403, problemTypes.recentSignInRequired);
    expectProblem(await addPasskey(cookie, "Key", createSoftwarePasskey().register(options)), 403, problemTypes.recentSignInRequired);
    expectProblem(await callRoute(test, routes.removePasskey, { cookie, params: passkey.id }), 403, problemTypes.recentSignInRequired);
    expect(await passkeys(cookie)).toHaveLength(1);
    expect((await callRoute(test, routes.renamePasskey, { cookie, params: passkey.id, payload: { name: "Laptop" } })).statusCode).toBe(200);
  });

  it("removes a passkey, audited, but never the account's last factor", async () => {
    const first = createSoftwarePasskey();
    const cookie = await withOnlyPasskey(first);
    const only = (await passkeys(cookie))[0]?.id ?? "";
    expectProblem(await callRoute(test, routes.removePasskey, { cookie, params: only }), 409, problemTypes.lastSecondFactor);

    const { passkey: second } = await addPasskeyInSettings(test, cookie, createSoftwarePasskey(), "Key");
    expect((await callRoute(test, routes.removePasskey, { cookie, params: only })).statusCode).toBe(204);
    expect((await passkeys(cookie)).map((row) => row.id)).toEqual([second.id]);
    expectProblem(await callRoute(test, routes.removePasskey, { cookie, params: second.id }), 409, problemTypes.lastSecondFactor);
    expectProblem(await callRoute(test, routes.removePasskey, { cookie, params: only }), 404, problemTypes.notFound);
    expect(test.audited("second-factor.removed")).toMatchObject([
      {
        actorAccountId: admin.id,
        targetKind: "second-factor",
        targetId: only,
        details: { kind: "passkey", reason: "removed-in-settings" },
      },
    ]);
  });

  it("lets an authenticator app go once a passkey is there, and the passkey is then the last factor", async () => {
    const cookie = await withTotp();
    const { passkey } = await addPasskeyInSettings(test, cookie, createSoftwarePasskey());
    const totp = (await callRoute(test, routes.getSecondFactors, { cookie }))
      .json<SecondFactors>()
      .factors.find((factor) => factor.kind === "totp");
    expect((await callRoute(test, routes.removeTotp, { cookie, params: totp?.id ?? "" })).statusCode).toBe(204);
    expectProblem(await callRoute(test, routes.removePasskey, { cookie, params: passkey.id }), 409, problemTypes.lastSecondFactor);
  });

  describe("refuses an attestation that doesn't pass, and saves nothing", () => {
    const cases: [string, CeremonyOverrides][] = [
      ["without user verification", { userVerified: false }],
      ["for another origin", { origin: "https://evil.example.com" }],
      ["for another RP ID", { rpId: "example.com" }],
      ["over another challenge", { challenge: Buffer.from("not the challenge").toString("base64url") }],
    ];
    it.each(cases)("%s", async (_case, overrides) => {
      const cookie = await withTotp();
      const response = createSoftwarePasskey().register(await registrationOptions(cookie), overrides);
      expectProblem(await addPasskey(cookie, "Phone", response), 422, problemTypes.secondFactorFailed);
      expect(tableRows(test, "passkey_credentials")).toEqual([]);
      expect(test.audited("second-factor.added").map((event) => event.details)).not.toContainEqual({ kind: "passkey" });
    });

    it("without a challenge, a replayed one or one older than 5 minutes", async () => {
      const cookie = await withTotp();
      expectProblem(
        await addPasskey(cookie, "Phone", createSoftwarePasskey().register(await registrationOptions(test.startSession(admin)))),
        422,
        problemTypes.secondFactorFailed,
      );

      const replayed = createSoftwarePasskey().register(await registrationOptions(cookie));
      expect((await addPasskey(cookie, "Phone", replayed)).statusCode).toBe(200);
      expectProblem(await addPasskey(cookie, "Phone", replayed), 422, problemTypes.secondFactorFailed);

      const late = createSoftwarePasskey().register(await registrationOptions(cookie));
      test.clock.advance(WEBAUTHN_CHALLENGE_LIFETIME_MS);
      expectProblem(await addPasskey(cookie, "Late", late), 422, problemTypes.secondFactorFailed);

      // Starting again voids the challenge before.
      const voided = createSoftwarePasskey().register(await registrationOptions(cookie));
      await registrationOptions(cookie);
      expectProblem(await addPasskey(cookie, "Voided", voided), 422, problemTypes.secondFactorFailed);
      expect(await passkeys(cookie)).toHaveLength(1);
    });
  });

  it("sweeps used and void challenges, keeping live ones", async () => {
    const cookie = await withTotp();
    await addPasskeyInSettings(test, cookie, createSoftwarePasskey());
    await registrationOptions(cookie);
    test.clock.advance(1);
    test.services.passkeys.sweep();
    expect(tableRows(test, "webauthn_challenges")).toMatchObject([{ purpose: "register", used_at: null }]);
    test.clock.advance(WEBAUTHN_CHALLENGE_LIFETIME_MS);
    test.services.passkeys.sweep();
    expect(tableRows(test, "webauthn_challenges")).toEqual([]);
  });

  it("is the admin's only: a user has no passkey routes", async () => {
    const user = test.startSession(test.createUser());
    for (const route of [routes.listPasskeys, routes.startPasskeyRegistration, routes.renamePasskey, routes.removePasskey]) {
      const payload = route.method === "PATCH" ? { payload: { name: "x" } } : {};
      expectProblem(await callRoute(test, route, { cookie: user, ...payload }), 403, problemTypes.forbidden);
    }
  });
});
