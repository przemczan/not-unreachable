import {
  problemTypes,
  routes,
  type RecoveryCodes,
  type SecondFactor,
  type SecondFactors,
  type TotpEnrolment,
} from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_SIGN_IN_MS } from "../../http/index.ts";
import {
  buildTestApp,
  expectProblem,
  sessionCookieHeader,
  sessionTokenFrom,
  testSecrets,
  type EnrolledAtSignIn,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { createSecrets, envelopeColumns, rotateMasterKey, SecretDecryptionError } from "../platform/index.ts";
import { PENDING_SESSION_LIFETIME_MS } from "../sessions/index.ts";
import { TOTP_ENROLMENT_LIFETIME_MS } from "./service.ts";
import { TOTP_PERIOD_SECONDS, totpCodeForStep, totpStepAt } from "./totp.ts";

const STEP_MS = TOTP_PERIOD_SECONDS * 1000;

let test: TestApp;
let admin: AccountRecord;

beforeEach(async () => {
  test = await buildTestApp();
  admin = await test.createAdmin({ username: "root.admin" });
});
afterEach(() => test.close());

const pending = async (): Promise<string> => (await test.signInWithPassword("root.admin")).cookie;
const cookieOf = (response: LightMyRequestResponse): string => sessionCookieHeader(sessionTokenFrom(response));
const passTotp = (cookie: string, code: string) => callRoute(test, routes.passTotp, { cookie, payload: { code } });
const passRecoveryCode = (cookie: string, code: string) => callRoute(test, routes.passRecoveryCode, { cookie, payload: { code } });
const wrongCode = (code: string): string => (code === "000000" ? "111111" : "000000");

describe("the second step at sign-in (threat model, T10)", () => {
  it("forces an admin without a factor to enrol, then makes the session active with a new token", async () => {
    const cookie = await pending();
    expect((await callRoute(test, routes.getSecondFactorStep, { cookie })).json()).toEqual({ mode: "enrol", methods: [] });
    expectProblem(await callRoute(test, routes.getProfile, { cookie }), 403, problemTypes.forbidden);
    expect((await callRoute(test, routes.getSession, { cookie })).json()).toMatchObject({
      state: "pendingSecondFactor",
      recentSignInUntil: null,
    });

    const enrolment = (await callRoute(test, routes.startTotpEnrolment, { cookie })).json<TotpEnrolment>();
    expect(enrolment.qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(enrolment.setupKey).toMatch(/^[A-Z2-7]{32}$/);
    const code = totpCodeForStep(enrolment.setupKey, totpStepAt(test.clock.now()));
    expectProblem(
      await callRoute(test, routes.confirmTotpEnrolment, { cookie, payload: { id: enrolment.id, code: wrongCode(code) } }),
      401,
      problemTypes.secondFactorFailed,
    );
    const confirmed = await callRoute(test, routes.confirmTotpEnrolment, { cookie, payload: { id: enrolment.id, code } });
    const { recoveryCodes } = confirmed.json<RecoveryCodes>();
    expect(recoveryCodes).toHaveLength(10);
    for (const recoveryCode of recoveryCodes) expect(recoveryCode).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
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
    expect(test.audited("second-factor.added")).toMatchObject([{ actorAccountId: admin.id, details: { kind: "totp" } }]);
    expect(test.audited("sign-in.succeeded")).toMatchObject([{ details: { method: "password", secondFactor: "totp" } }]);
  });

  it("refuses enrolment once a confirmed factor exists, so a password alone can't add one", async () => {
    await test.enrolAtSignIn(await pending());
    const cookie = await pending();
    expect((await callRoute(test, routes.getSecondFactorStep, { cookie })).json()).toEqual({
      mode: "verify",
      methods: ["totp", "recoveryCode"],
    });
    expectProblem(await callRoute(test, routes.startTotpEnrolment, { cookie }), 409, problemTypes.secondFactorExists);
    expectProblem(
      await callRoute(test, routes.confirmTotpEnrolment, { cookie, payload: { id: admin.id, code: "123456" } }),
      409,
      problemTypes.secondFactorExists,
    );
    expectProblem(await callRoute(test, routes.acknowledgeRecoveryCodes, { cookie }), 409, problemTypes.secondFactorExists);
    expect(tableRows(test, "totp_credentials")).toHaveLength(1);
  });

  it("answers an active session 403 on the second step", async () => {
    const { cookie } = await test.enrolAtSignIn(await pending());
    for (const route of [routes.getSecondFactorStep, routes.startTotpEnrolment, routes.acknowledgeRecoveryCodes]) {
      expectProblem(await callRoute(test, route, { cookie }), 403, problemTypes.forbidden);
    }
    expectProblem(await passTotp(cookie, "123456"), 403, problemTypes.forbidden);
  });

  it("passes a TOTP code of the step before, the current or the one after, each step once", async () => {
    const { setupKey } = await test.enrolAtSignIn(await pending());
    test.clock.advance(2 * STEP_MS);
    const current = totpStepAt(test.clock.now());
    const codeAt = (offset: number): string => totpCodeForStep(setupKey, current + offset);

    const first = await pending();
    const passed = await passTotp(first, codeAt(-1));
    expect(passed.statusCode).toBe(200);
    expect(passed.json()).toMatchObject({ state: "active" });
    expectProblem(await callRoute(test, routes.getSession, { cookie: first }), 401, problemTypes.signInRequired);

    const second = await pending();
    expectProblem(await passTotp(second, codeAt(-1)), 401, problemTypes.secondFactorFailed);
    expectProblem(await passTotp(second, codeAt(2)), 401, problemTypes.secondFactorFailed);
    expect((await passTotp(second, codeAt(1))).statusCode).toBe(200);
    expectProblem(await passTotp(await pending(), codeAt(0)), 401, problemTypes.secondFactorFailed);
    expect(test.audited("second-factor.failed")).toHaveLength(3);
  });

  it("passes a recovery code once, in any case, and audits it", async () => {
    const { recoveryCodes } = await test.enrolAtSignIn(await pending());
    const code = recoveryCodes[0] ?? "";
    const passed = await passRecoveryCode(await pending(), code.toLowerCase().replace("-", " "));
    expect(passed.statusCode).toBe(200);
    expect(test.audited("second-factor.recovery-code-used")).toMatchObject([{ actorAccountId: admin.id, details: { remaining: 9 } }]);
    const signIns = test.audited("sign-in.succeeded").map((event) => event.details["secondFactor"]);
    expect(signIns).toHaveLength(2);
    expect(signIns).toEqual(expect.arrayContaining(["totp", "recoveryCode"]));

    expectProblem(await passRecoveryCode(await pending(), code), 401, problemTypes.secondFactorFailed);
    const stored = tableRows(test, "recovery_codes");
    expect(stored).toHaveLength(10);
    for (const row of stored) expect(String(row["code_hash"])).toMatch(/^\$argon2id\$/);
  });

  it("revokes the pending session at the 5th wrong code within 15 minutes, and audits every failure", async () => {
    await test.enrolAtSignIn(await pending());
    const cookie = await pending();
    for (let attempt = 1; attempt <= 4; attempt += 1) expectProblem(await passTotp(cookie, "000000"), 401, problemTypes.secondFactorFailed);
    expectProblem(await passRecoveryCode(cookie, "AAAAA-AAAAA"), 429, problemTypes.tooManyAttempts);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);

    const failures = test.audited("second-factor.failed");
    expect(failures).toHaveLength(5);
    // Events of one millisecond come in no set order.
    expect(failures.filter((failure) => failure.details["limitReached"] === true)).toMatchObject([
      { outcome: "failed", details: { method: "recoveryCode", during: "sign-in", limitReached: true } },
    ]);
    expect(test.audited("session.revoked")).toMatchObject([{ details: { reason: "second-factor-limit" } }]);
  });

  it("revokes the pending session at the 10th wrong code within an hour for the account", async () => {
    await test.enrolAtSignIn(await pending());
    for (let session = 1; session <= 2; session += 1) {
      const cookie = await pending();
      for (let attempt = 1; attempt <= 4; attempt += 1)
        expectProblem(await passTotp(cookie, "000000"), 401, problemTypes.secondFactorFailed);
    }
    const cookie = await pending();
    expectProblem(await passTotp(cookie, "000000"), 401, problemTypes.secondFactorFailed);
    expectProblem(await passTotp(cookie, "000000"), 429, problemTypes.tooManyAttempts);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
    // Past the account's limit, a new session can't try either, even with the right code.
    const next = await pending();
    expectProblem(await passTotp(next, test.totpCode(admin.id)), 429, problemTypes.tooManyAttempts);

    test.clock.advance(60 * 60 * 1000 + 1);
    expect((await passTotp(await pending(), test.totpCode(admin.id))).statusCode).toBe(200);
  });

  it("counts a burst of parallel wrong codes one by one, so it can't outrun the try limit", async () => {
    await test.enrolAtSignIn(await pending());
    const cookie = await pending();
    const burst = await Promise.all(Array.from({ length: 8 }, () => passRecoveryCode(cookie, "AAAAA-AAAAA")));
    expect(burst.filter((response) => response.statusCode === 200)).toEqual([]);
    expect(burst.filter((response) => response.statusCode === 401 && response.body.includes(problemTypes.secondFactorFailed))).toHaveLength(
      4,
    );
    expect(test.audited("second-factor.failed")).toHaveLength(5);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
  });

  it("lets the admin enrol at once after reset-admin removes the factors, even past the account's try limit", async () => {
    await test.enrolAtSignIn(await pending());
    for (let session = 1; session <= 2; session += 1) {
      const cookie = await pending();
      for (let attempt = 1; attempt <= 5; attempt += 1) await passTotp(cookie, "000000");
    }
    expectProblem(await passTotp(await pending(), test.totpCode(admin.id)), 429, problemTypes.tooManyAttempts);

    test.services.secondFactors.removeAll(admin.id);
    const cookie = await pending();
    expect((await callRoute(test, routes.getSecondFactorStep, { cookie })).json()).toEqual({ mode: "enrol", methods: [] });
    expect((await test.enrolAtSignIn(cookie)).recoveryCodes).toHaveLength(10);
  });

  it("ends a pending session after 5 minutes", async () => {
    await test.enrolAtSignIn(await pending());
    const cookie = await pending();
    test.clock.advance(PENDING_SESSION_LIFETIME_MS - 1);
    expect((await callRoute(test, routes.getSession, { cookie })).statusCode).toBe(200);
    test.clock.advance(1);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
    expectProblem(await passTotp(cookie, "123456"), 401, problemTypes.signInRequired);
  });

  it("renews the recent sign-in with an authenticator code too", async () => {
    const { cookie } = await test.enrolAtSignIn(await pending());
    test.clock.advance(RECENT_SIGN_IN_MS);
    expectProblem(
      await callRoute(test, routes.confirmSession, { cookie, payload: { code: "000000" } }),
      401,
      problemTypes.secondFactorFailed,
    );
    expect(test.audited("second-factor.failed")).toMatchObject([{ details: { during: "confirm", limitReached: false } }]);
    const confirmed = await callRoute(test, routes.confirmSession, { cookie, payload: { code: test.totpCode(admin.id) } });
    expect(confirmed.statusCode).toBe(200);
    expect((await callRoute(test, routes.regenerateRecoveryCodes, { cookie: cookieOf(confirmed) })).statusCode).toBe(200);
  });
});

describe("Settings → Two-step sign-in", () => {
  let enrolled: EnrolledAtSignIn;
  let cookie: string;

  beforeEach(async () => {
    enrolled = await test.enrolAtSignIn(await pending());
    cookie = enrolled.cookie;
  });

  const factors = async () => (await callRoute(test, routes.getSecondFactors, { cookie })).json<SecondFactors>();

  it("lists the authenticator app and how many recovery codes are left", async () => {
    expect(await factors()).toEqual({
      factors: [{ id: expect.any(String), kind: "totp", createdAt: test.clock.now().toISOString(), lastUsedAt: expect.any(String) }],
      recoveryCodes: { remaining: 10, createdAt: test.clock.now().toISOString() },
    });
  });

  it("adds another authenticator app once its code is confirmed, then removes one, but never the last", async () => {
    const enrolment = (await callRoute(test, routes.addTotp, { cookie })).json<TotpEnrolment>();
    expect((await factors()).factors).toHaveLength(1);
    const code = totpCodeForStep(enrolment.setupKey, totpStepAt(test.clock.now()));
    const added = await callRoute(test, routes.confirmTotp, { cookie, params: enrolment.id, payload: { code } });
    expect(added.statusCode).toBe(200);
    expect(added.json<SecondFactor>()).toMatchObject({ id: enrolment.id, kind: "totp" });
    expect((await factors()).factors).toHaveLength(2);

    const first = (await factors()).factors[0]?.id ?? "";
    expect((await callRoute(test, routes.removeTotp, { cookie, params: first })).statusCode).toBe(204);
    expectProblem(await callRoute(test, routes.removeTotp, { cookie, params: enrolment.id }), 409, problemTypes.lastSecondFactor);
    expect((await factors()).factors.map((factor) => factor.id)).toEqual([enrolment.id]);
    expect(test.audited("second-factor.added")).toHaveLength(2);
    expect(test.audited("second-factor.removed")).toMatchObject([
      { targetId: first, details: { kind: "totp", reason: "removed-in-settings" } },
    ]);
  });

  it("voids an authenticator app not confirmed within 10 minutes, and sweeps it", async () => {
    const enrolment = (await callRoute(test, routes.addTotp, { cookie })).json<TotpEnrolment>();
    test.clock.advance(TOTP_ENROLMENT_LIFETIME_MS);
    // Renewed with the first app, as the recent sign-in lapsed too.
    const renewed = await callRoute(test, routes.confirmSession, { cookie, payload: { code: test.totpCode(admin.id) } });
    const active = cookieOf(renewed);
    const code = totpCodeForStep(enrolment.setupKey, totpStepAt(test.clock.now()));
    expectProblem(
      await callRoute(test, routes.confirmTotp, { cookie: active, params: enrolment.id, payload: { code } }),
      422,
      problemTypes.secondFactorFailed,
    );
    test.services.secondFactors.sweep();
    expect(tableRows(test, "totp_credentials").map((row) => row["id"])).not.toContain(enrolment.id);
    expect(tableRows(test, "totp_credentials")).toHaveLength(1);
  });

  it("regenerates the recovery codes, which voids every earlier one", async () => {
    const regenerated = (await callRoute(test, routes.regenerateRecoveryCodes, { cookie })).json<RecoveryCodes>();
    expect(regenerated.recoveryCodes).toHaveLength(10);
    expect(regenerated.recoveryCodes).not.toContain(enrolled.recoveryCodes[0]);
    expect(tableRows(test, "recovery_codes")).toHaveLength(10);
    expect(test.audited("recovery-codes.regenerated")).toMatchObject([{ details: { count: 10 } }]);

    expectProblem(await passRecoveryCode(await pending(), enrolled.recoveryCodes[0] ?? ""), 401, problemTypes.secondFactorFailed);
    expect((await passRecoveryCode(await pending(), regenerated.recoveryCodes[0] ?? "")).statusCode).toBe(200);
  });

  it("is the admin's only: a user has no second-factor routes", async () => {
    const user = test.startSession(test.createUser());
    for (const route of [routes.getSecondFactors, routes.addTotp, routes.regenerateRecoveryCodes, routes.removeTotp]) {
      expectProblem(await callRoute(test, route, { cookie: user }), 403, problemTypes.forbidden);
    }
  });
});

describe("TOTP secrets (threat model, T10)", () => {
  it("are stored as envelopes bound to their row, never answered after enrolment nor audited", async () => {
    const { cookie, setupKey } = await test.enrolAtSignIn(await pending());
    const [row] = tableRows(test, "totp_credentials");
    const envelope = String(row?.["secret"]);
    expect(envelope).not.toContain(setupKey);
    expect(testSecrets.decrypt("totp", { table: "totp_credentials", column: "secret", rowId: String(row?.["id"]) }, envelope)).toBe(
      setupKey,
    );
    expect(() => testSecrets.decrypt("totp", { table: "totp_credentials", column: "secret", rowId: admin.id }, envelope)).toThrow(
      SecretDecryptionError,
    );

    const answers = [
      await callRoute(test, routes.getSecondFactors, { cookie }),
      await callRoute(test, routes.listAuditEvents, { cookie }),
      await callRoute(test, routes.exportAuditEvents, { cookie }),
      await callRoute(test, routes.getSession, { cookie }),
    ];
    for (const answer of answers) {
      expect(answer.statusCode).toBe(200);
      expect(answer.body).not.toContain(setupKey);
      expect(answer.body).not.toContain(envelope);
    }
    expect(JSON.stringify(test.audited())).not.toContain(setupKey);
    expect(
      test
        .logs()
        .map((line) => JSON.stringify(line))
        .join("\n"),
    ).not.toContain(setupKey);
  });

  it("are re-encrypted by rotate-key", async () => {
    const { setupKey } = await test.enrolAtSignIn(await pending());
    const newKey = Buffer.alloc(32, 9);
    const rotated = rotateMasterKey({ database: test.database, oldKey: Buffer.alloc(32, 7), newKey, columns: envelopeColumns });
    expect(rotated).toContainEqual({ table: "totp_credentials", column: "secret", reencrypted: 1 });

    const [row] = tableRows(test, "totp_credentials");
    const aad = { table: "totp_credentials", column: "secret", rowId: String(row?.["id"]) };
    expect(createSecrets(newKey).decrypt("totp", aad, String(row?.["secret"]))).toBe(setupKey);
    expect(() => testSecrets.decrypt("totp", aad, String(row?.["secret"]))).toThrow(SecretDecryptionError);
  });
});
