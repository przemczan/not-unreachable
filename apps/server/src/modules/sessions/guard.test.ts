import { accessLevels, problemMediaType, problemTypes, routes, type Access, type RouteContract } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpProblem, RECENT_SIGN_IN_MS, type Caller } from "../../http/index.ts";
import {
  buildTestApp,
  expectProblem,
  fakeClock,
  goodPassword,
  sessionTokenFrom,
  sessionCookieHeader,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute } from "../../test-support/sessions.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { enforceContract } from "./index.ts";

const table: [string, RouteContract][] = Object.entries(routes);
const byAccess = (...levels: Access[]) => table.filter(([, route]) => levels.includes(route.access));
const adminRoutes = table.filter(([, route]) => route.path.startsWith("/api/v1/admin/"));
const nonPublic = byAccess("pendingSecondFactor", "account", "user", "admin");
const activeOnly = byAccess("account", "user", "admin");
const recentSignInRoutes = table.filter(([, route]) => route.recentSignIn);

/** The refusal's problem; a HEAD answer (tus) has no body, so only its status and media type tell. */
function expectRefused(route: RouteContract, response: LightMyRequestResponse, status: number, type: string): void {
  if (route.method !== "HEAD") {
    expectProblem(response, status, type);
    return;
  }
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toBe(`${problemMediaType}; charset=utf-8`);
}

/**
 * Every route a session pending its second factor reaches (threat model, T10): the second step,
 * signing out, and reading its own session, so the SPA knows to show the second step.
 */
const pendingSessionRoutes = [
  "getSecondFactorStep",
  "passTotp",
  "passRecoveryCode",
  "startPasskeySecondFactor",
  "passPasskey",
  "startTotpEnrolment",
  "confirmTotpEnrolment",
  "startPasskeyEnrolment",
  "confirmPasskeyEnrolment",
  "acknowledgeRecoveryCodes",
  "signOut",
  "getSession",
];

describe("the route table, through the guard", () => {
  let test: TestApp;
  let admin: AccountRecord;
  let user: AccountRecord;

  beforeAll(async () => {
    // With every switch on, so every route of the table is registered (routes.test.ts checks the off case).
    test = await buildTestApp({ config: { allowFoldersFromUi: true, updateCheck: true, updateFromUi: true } });
    admin = await test.createAdmin();
    user = test.createUser();
  });
  afterAll(() => test.close());

  it("has routes of every kind to check", () => {
    expect(adminRoutes.length).toBeGreaterThan(0);
    expect(nonPublic.length).toBeGreaterThan(0);
    expect(recentSignInRoutes.length).toBeGreaterThan(0);
    expect(byAccess("pendingSecondFactor").length).toBeGreaterThan(0);
  });

  it("lets a session pending its second factor reach only the second step, sign-out and its session", () => {
    expect(
      byAccess("pendingSecondFactor")
        .map(([name]) => name)
        .toSorted(),
    ).toEqual(pendingSessionRoutes.toSorted());
  });

  it("states an access level for every route the app registers", () => {
    for (const [, route] of table) {
      expect(accessLevels).toContain(route.access);
      expect(test.app.hasRoute({ method: route.method, url: route.path })).toBe(true);
    }
  });

  it.each(adminRoutes)("%s is for the admin only", (_name, route) => {
    expect(route.access).toBe("admin");
  });

  it.each(adminRoutes)("%s answers a user 403", async (_name, route) => {
    const cookie = test.startSession(user);
    expectProblem(await callRoute(test, route, { cookie }), 403, problemTypes.forbidden);
  });

  it.each(nonPublic)("%s answers 401 without a session, or with an unknown one", async (_name, route) => {
    expectRefused(route, await callRoute(test, route), 401, problemTypes.signInRequired);
    expectRefused(route, await callRoute(test, route, { cookie: sessionCookieHeader("A".repeat(43)) }), 401, problemTypes.signInRequired);
  });

  it.each(adminRoutes.filter(([, route]) => route.method === "GET"))("HEAD %s is guarded like its GET", async (_name, route) => {
    const anonymous = await callRoute(test, { ...route, method: "HEAD" });
    expect(anonymous.statusCode).toBe(401);
    const asUser = await callRoute(test, { ...route, method: "HEAD" }, { cookie: test.startSession(user) });
    expect(asUser.statusCode).toBe(403);
  });

  it.each(byAccess("user"))("%s answers the admin 403", async (_name, route) => {
    expectProblem(await callRoute(test, route, { cookie: test.startSession(admin) }), 403, problemTypes.forbidden);
  });

  it.each(activeOnly)("%s refuses a session still waiting for its second factor", async (_name, route) => {
    const owner = route.access === "user" ? user : admin;
    const cookie = test.startSession(owner, { state: "pendingSecondFactor", recentSignIn: false });
    expectRefused(route, await callRoute(test, route, { cookie }), 403, problemTypes.forbidden);
  });

  it.each(byAccess("pendingSecondFactor").filter(([, route]) => route.method === "GET"))(
    "%s lets a session waiting for its second factor through",
    async (_name, route) => {
      const cookie = test.startSession(admin, { state: "pendingSecondFactor", recentSignIn: false });
      expect((await callRoute(test, route, { cookie })).statusCode).toBe(200);
    },
  );

  it("lets a session waiting for its second factor sign out", async () => {
    const cookie = test.startSession(admin, { state: "pendingSecondFactor", recentSignIn: false });
    expect((await callRoute(test, routes.signOut, { cookie })).statusCode).toBe(204);
    expectProblem(await callRoute(test, routes.getSession, { cookie }), 401, problemTypes.signInRequired);
  });

  it.each(recentSignInRoutes)("%s answers recent-sign-in-required 10 minutes after the sign-in", async (_name, route) => {
    const owner = route.access === "user" ? user : admin;
    expectProblem(
      await callRoute(test, route, { cookie: test.startSession(owner, { recentSignIn: false }) }),
      403,
      problemTypes.recentSignInRequired,
    );

    const cookie = test.startSession(owner);
    test.clock.advance(RECENT_SIGN_IN_MS - 1);
    // Still recent: the guard lets it through to validation, which refuses the empty body, or (with
    // no body to give) to the handler, which finds no such id or does what the route does.
    expect([200, 400, 404]).toContain((await callRoute(test, route, { cookie })).statusCode);
    test.clock.advance(1);
    expectProblem(await callRoute(test, route, { cookie }), 403, problemTypes.recentSignInRequired);
  });

  it("renews the recent sign-in on confirm, with a new token", async () => {
    const signedIn = test.startSession(admin);
    test.clock.advance(RECENT_SIGN_IN_MS);
    const route = routes.updateSecuritySettings;
    expectProblem(await callRoute(test, route, { cookie: signedIn }), 403, problemTypes.recentSignInRequired);

    const confirmed = await callRoute(test, routes.confirmSession, { cookie: signedIn, payload: { password: goodPassword } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ recentSignInUntil: new Date(test.clock.now().getTime() + RECENT_SIGN_IN_MS).toISOString() });
    const cookie = sessionCookieHeader(sessionTokenFrom(confirmed));
    expect((await callRoute(test, route, { cookie })).statusCode).toBe(400);
    expectProblem(await callRoute(test, routes.getSession, { cookie: signedIn }), 401, problemTypes.signInRequired);
  });
});

describe("enforceContract", () => {
  const clock = fakeClock();
  const caller = (overrides: Partial<Caller> = {}): Caller => ({
    accountId: "a",
    username: "someone",
    role: "user",
    sessionId: "s",
    state: "active",
    recentSignInAt: clock.now(),
    ...overrides,
  });
  const problemOf = (access: Access, who: Caller | null, recentSignIn = false): string | undefined => {
    try {
      enforceContract({ access, recentSignIn }, who, clock);
      return undefined;
    } catch (error) {
      if (!(error instanceof HttpProblem)) throw error;
      return `${error.status} ${error.type}`;
    }
  };
  const forbidden = `403 ${problemTypes.forbidden}`;
  const signInRequired = `401 ${problemTypes.signInRequired}`;

  it("lets anyone through a public route", () => {
    expect(problemOf("public", null)).toBeUndefined();
    expect(problemOf("public", caller({ state: "pendingSecondFactor" }))).toBeUndefined();
  });

  it.each(["pendingSecondFactor", "account", "user", "admin"] as const)("needs a session for a %s route", (access) => {
    expect(problemOf(access, null)).toBe(signInRequired);
  });

  it("keeps each role to its own routes", () => {
    const admin = caller({ role: "admin" });
    const user = caller({ role: "user" });
    expect(problemOf("admin", admin)).toBeUndefined();
    expect(problemOf("admin", user)).toBe(forbidden);
    expect(problemOf("user", user)).toBeUndefined();
    expect(problemOf("user", admin)).toBe(forbidden);
    expect(problemOf("account", admin)).toBeUndefined();
    expect(problemOf("account", user)).toBeUndefined();
  });

  it("lets a pending session reach only pendingSecondFactor routes", () => {
    const pending = caller({ state: "pendingSecondFactor", role: "admin" });
    expect(problemOf("pendingSecondFactor", pending)).toBeUndefined();
    for (const access of ["account", "user", "admin"] as const) expect(problemOf(access, pending)).toBe(forbidden);
  });

  it("needs a sign-in in the last 10 minutes on a recentSignIn route", () => {
    const recent = `403 ${problemTypes.recentSignInRequired}`;
    const at = (millisecondsAgo: number) => caller({ recentSignInAt: new Date(clock.now().getTime() - millisecondsAgo) });
    expect(problemOf("account", at(RECENT_SIGN_IN_MS - 1), true)).toBeUndefined();
    expect(problemOf("account", at(RECENT_SIGN_IN_MS), true)).toBe(recent);
    expect(problemOf("account", caller({ recentSignInAt: null }), true)).toBe(recent);
    expect(problemOf("account", caller({ recentSignInAt: null }), false)).toBeUndefined();
    // The role is checked first: a user never learns that an admin route wants a recent sign-in.
    expect(problemOf("admin", at(RECENT_SIGN_IN_MS), true)).toBe(forbidden);
  });
});
