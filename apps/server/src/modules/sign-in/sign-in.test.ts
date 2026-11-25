import { problemTypes, routes } from "@not-unreachable/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTestApp,
  expectProblem,
  goodPassword,
  sameOriginWrite,
  sessionCookieHeader,
  sessionTokenFrom,
  type TestApp,
} from "../../test-support/index.ts";
import { tableRows } from "../../test-support/sessions.ts";
import { users, type AccountRecord } from "../accounts/index.ts";
import { openSignInGate, perIpLimits } from "./index.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The answers' status codes, lowest first, as parallel requests finish in any order. */
function statuses(responses: readonly { statusCode: number }[]): number[] {
  return responses.map((response) => response.statusCode).toSorted((a, b) => a - b);
}

describe("sign-in limits over HTTP (threat model, T11)", () => {
  let t: TestApp;
  let admin: AccountRecord;

  const signIn = (identifier: string, password: string, ip = "203.0.113.1") =>
    t.app.inject({
      method: "POST",
      url: routes.signIn.path,
      headers: { ...sameOriginWrite, "x-forwarded-for": ip, "user-agent": "limits-test" },
      payload: { identifier, password },
    });

  beforeEach(async () => {
    t = await buildTestApp();
    admin = await t.createAdmin();
  });
  afterEach(async () => {
    await t.close();
  });

  it("answers 429 too-many-attempts with Retry-After after 10 attempts a minute from one IP, and audits it once", async () => {
    for (let i = 0; i < 10; i++) expect((await signIn(`nobody${i}`, "wrong password")).statusCode).toBe(401);
    for (let i = 0; i < 3; i++) {
      const refused = await signIn("admin", goodPassword);
      expectProblem(refused, 429, problemTypes.tooManyAttempts);
      expect(refused.headers["retry-after"]).toBe("60");
    }
    expect((await signIn("admin", goodPassword, "203.0.113.2")).statusCode).toBe(200);
    expect(t.audited("rate-limit.triggered")).toMatchObject([
      {
        actorKind: "anonymous",
        outcome: "denied",
        ip: "203.0.113.1",
        userAgent: "limits-test",
        details: { limit: perIpLimits.perMinute, key: "203.0.113.1" },
      },
    ]);
    t.clock.advance(MINUTE);
    expect((await signIn("admin", goodPassword)).statusCode).toBe(200);
  });

  it("answers 429 after 50 attempts an hour from one IP", async () => {
    for (let i = 0; i < 50; i++) {
      expect((await signIn(`nobody${i}`, "wrong password")).statusCode).toBe(401);
      t.clock.advance(7 * SECOND);
    }
    const refused = await signIn("admin", goodPassword);
    expectProblem(refused, 429, problemTypes.tooManyAttempts);
    expect(refused.headers["retry-after"]).toBe(String(3600 - 50 * 7));
    expect(t.audited("rate-limit.triggered")).toMatchObject([{ details: { limit: perIpLimits.perHour } }]);
  });

  it("delays an IP after 5 failures for an account: 1 s, 2 s, 4 s … capped at 60 s, even for the right password", async () => {
    for (let i = 0; i < 4; i++) expect((await signIn("admin", "wrong password")).statusCode).toBe(401);
    const delays: string[] = [];
    for (let i = 0; i < 8; i++) {
      t.clock.advance(MINUTE); // stay under the per-IP limit
      expect((await signIn("admin", "wrong password")).statusCode).toBe(401);
      const refused = await signIn("admin", goodPassword);
      expectProblem(refused, 429, problemTypes.tooManyAttempts);
      delays.push(String(refused.headers["retry-after"]));
    }
    expect(delays).toEqual(["1", "2", "4", "8", "16", "32", "60", "60"]);
    expect(t.audited("sign-in.failed").filter((event) => event.details["reason"] === "delayed")).toHaveLength(8);
    // Another IP is not delayed; success there leaves this IP's delay alone.
    expect((await signIn("admin", goodPassword, "203.0.113.7")).statusCode).toBe(200);
    expect((await signIn("admin", goodPassword)).statusCode).toBe(429);
    t.clock.advance(MINUTE);
    expect((await signIn("admin", goodPassword)).statusCode).toBe(200);
    // Success cleared this IP's failures: the next ones start from zero.
    for (let i = 0; i < 4; i++) expect((await signIn("admin", "wrong password")).statusCode).toBe(401);
    expect((await signIn("admin", goodPassword)).statusCode).toBe(200);
  });

  it("locks the account for 15 minutes after 20 failures within an hour from any IPs, audited, then lets it in", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await signIn("admin", "wrong password", `198.51.100.${i + 1}`)).statusCode).toBe(401);
      t.clock.advance(2 * MINUTE);
    }
    const refused = await signIn("admin", goodPassword, "192.0.2.1");
    expectProblem(refused, 429, problemTypes.tooManyAttempts);
    expect(Number(refused.headers["retry-after"])).toBe(15 * 60 - 2 * 60);
    expect(t.audited("sign-in.locked")).toMatchObject([
      { actorKind: "system", targetKind: "account", targetId: admin.id, ip: "198.51.100.20", details: { failures: 20 } },
    ]);
    expect(t.audited("sign-in.failed")[0]).toMatchObject({ targetId: admin.id, details: { reason: "locked" } });
    t.clock.advance(13 * MINUTE - 1);
    expect((await signIn("admin", goodPassword, "192.0.2.2")).statusCode).toBe(429);
    t.clock.advance(1);
    expect((await signIn("admin", goodPassword, "192.0.2.3")).statusCode).toBe(200);
  });

  it("delays an unknown identifier exactly like the admin, so a 429 shows no account exists (T1)", async () => {
    // Raised so only the delay, not the per-IP limit, can answer 429 here.
    t.services.settings.set("signInLimits", { ...t.services.settings.get("signInLimits"), perIpPerMinute: 50 }, null);
    for (let i = 0; i < 5; i++) {
      expect((await signIn("admin", "wrong password")).statusCode).toBe(401);
      expect((await signIn("nobody", "wrong password")).statusCode).toBe(401);
    }
    const known = await signIn("admin", "wrong password");
    const unknown = await signIn("nobody", "wrong password");
    expectProblem(known, 429, problemTypes.tooManyAttempts);
    expect({ status: unknown.statusCode, body: unknown.body, retryAfter: unknown.headers["retry-after"] }).toEqual({
      status: known.statusCode,
      body: known.body,
      retryAfter: known.headers["retry-after"],
    });
  });

  it("counts a burst of parallel failures one by one, so it can't outrun the delay or the lock", async () => {
    // From one IP: the delay starts after the 5th failure, so the rest wait.
    const fromOneIp = await Promise.all(Array.from({ length: 8 }, () => signIn("admin", "wrong password")));
    expect(statuses(fromOneIp)).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);

    // From many IPs: the lock (here after 10 failures) holds whatever the burst.
    t.services.settings.set("signInLimits", { ...t.services.settings.get("signInLimits"), lockAfterFailures: 10 }, null);
    const fromManyIps = await Promise.all(Array.from({ length: 12 }, (_, i) => signIn("admin", "wrong password", `198.51.100.${i + 1}`)));
    expect(statuses(fromManyIps)).toEqual([...Array.from({ length: 5 }, () => 401), ...Array.from({ length: 7 }, () => 429)]);
    expect(t.audited("sign-in.failed").filter((event) => event.details["reason"] === "wrong-password")).toHaveLength(10);
    expect(t.audited("sign-in.locked")).toHaveLength(1);
  });

  it("records sign-in.failed, sign-in.succeeded once the second factor passes, and sign-out", async () => {
    expect((await signIn("admin", "wrong password")).statusCode).toBe(401);
    expect(t.audited("sign-in.failed")).toMatchObject([
      {
        actorKind: "anonymous",
        outcome: "failed",
        targetId: admin.id,
        ip: "203.0.113.1",
        details: { method: "password", reason: "wrong-password" },
      },
    ]);
    const response = await signIn("admin", goodPassword);
    expect(response.statusCode).toBe(200);
    expect(t.audited("sign-in.succeeded")).toEqual([]);
    const { cookie } = await t.enrolAtSignIn(sessionCookieHeader(sessionTokenFrom(response)));
    expect(t.audited("sign-in.succeeded")).toMatchObject([
      {
        actorKind: "account",
        actorAccountId: admin.id,
        outcome: "succeeded",
        targetId: admin.id,
        details: { method: "password", secondFactor: "totp" },
      },
    ]);
    const signedOut = await t.app.inject({ method: "POST", url: routes.signOut.path, headers: { ...sameOriginWrite, cookie } });
    expect(signedOut.statusCode).toBe(204);
    expect(t.audited("sign-out")).toMatchObject([
      { actorKind: "account", actorAccountId: admin.id, outcome: "succeeded", targetKind: "session" },
    ]);
  });
});

describe("failed sign-ins look alike (threat model, T1)", () => {
  let t: TestApp;

  beforeEach(async () => {
    // Real argon2 with the test parameters; the limits would refuse this many tries from one IP.
    t = await buildTestApp({ signInGate: openSignInGate });
    await t.createAdmin();
  });
  afterEach(async () => {
    await t.close();
  });

  it("gives byte-identical 401 bodies and p50 timings within 50 ms for every kind of failure", async () => {
    const user = t.createUser({ username: "nopassword" });
    const disabledUser = t.createUser({ username: "disabled" });
    await t.services.accounts.setPassword(disabledUser.id, goodPassword);
    t.database.db.update(users).set({ status: "disabled" }).where(eq(users.id, disabledUser.id)).run();
    expect(user.status).toBe("active");

    const cases = {
      unknown: { identifier: "nobody", password: goodPassword },
      wrongPassword: { identifier: "admin", password: "wrong password" },
      disabled: { identifier: "disabled", password: goodPassword },
      noPassword: { identifier: "nopassword", password: goodPassword },
    } as const;
    const attempt = (payload: { identifier: string; password: string }) =>
      t.app.inject({ method: "POST", url: routes.signIn.path, headers: sameOriginWrite, payload });

    // Warm up: the dummy hash is made on first use.
    for (const payload of Object.values(cases)) await attempt(payload);

    const bodies = new Set<string>();
    const timings: Record<string, number[]> = {};
    for (let run = 0; run < 15; run++) {
      for (const [name, payload] of Object.entries(cases)) {
        const started = performance.now();
        const response = await attempt(payload);
        (timings[name] ??= []).push(performance.now() - started);
        expect(response.statusCode).toBe(401);
        bodies.add(response.body);
      }
    }
    expect([...bodies]).toEqual([JSON.stringify({ type: problemTypes.signInFailed, title: "Sign-in failed", status: 401 })]);
    const p50 = Object.values(timings).map((values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0);
    expect(Math.max(...p50) - Math.min(...p50)).toBeLessThan(50);
    const reasons = new Set(t.audited("sign-in.failed").map((event) => event.details["reason"]));
    expect(reasons).toEqual(new Set(["disabled", "no-password", "unknown-account", "wrong-password"]));
  });

  it("takes a password from the admin only: a user with a stored hash gets the 401 of an unknown account", async () => {
    const user = t.createUser({ username: "hashed.user", email: "hashed@example.com" });
    // No route stores a user's password; were one ever stored, it still signs nobody in.
    await t.services.accounts.setPassword(user.id, goodPassword);
    const attempt = (identifier: string) =>
      t.app.inject({ method: "POST", url: routes.signIn.path, headers: sameOriginWrite, payload: { identifier, password: goodPassword } });
    const answerOf = (response: Awaited<ReturnType<typeof attempt>>) => ({
      status: response.statusCode,
      body: response.body,
      cookie: response.headers["set-cookie"],
    });

    const unknown = answerOf(await attempt("nobody"));
    expect(unknown).toEqual({ status: 401, body: expect.stringContaining(problemTypes.signInFailed), cookie: undefined });
    for (const identifier of ["hashed.user", "Hashed@Example.com"]) expect(answerOf(await attempt(identifier))).toEqual(unknown);
    expect(tableRows(t, "sessions")).toEqual([]);
    expect(
      t
        .audited("sign-in.failed")
        .filter((event) => event.targetId === user.id)
        .map((event) => event.details["reason"]),
    ).toEqual(["no-password", "no-password"]);

    // Nor does it renew a user's recent sign-in.
    const cookie = t.startSession(user, { recentSignIn: false });
    const confirmed = await t.app.inject({
      method: "POST",
      url: routes.confirmSession.path,
      headers: { ...sameOriginWrite, cookie },
      payload: { password: goodPassword },
    });
    expectProblem(confirmed, 401, problemTypes.signInFailed);
  });
});
