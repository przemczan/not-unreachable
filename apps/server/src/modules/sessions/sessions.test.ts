import { problemTypes, routes } from "@not-unreachable/contracts";
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
import { callRoute, tableRows } from "../../test-support/sessions.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { hashToken, MINUTE_MS } from "../platform/index.ts";
import { readSessionToken, SESSION_COOKIE } from "./index.ts";

const HOUR_MS = 60 * MINUTE_MS;
const newPassword = "an entirely different passphrase";

function setCookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header.join("\n") : header;
  if (typeof value !== "string") throw new Error("No Set-Cookie header");
  return value;
}

describe("sessions", () => {
  let test: TestApp;
  let admin: AccountRecord;

  beforeEach(async () => {
    test = await buildTestApp();
    admin = await test.createAdmin();
  });
  afterEach(() => test.close());

  const signInResponse = (password = goodPassword, cookie?: string) =>
    test.app.inject({
      method: "POST",
      url: routes.signIn.path,
      headers: { ...sameOriginWrite, ...(cookie === undefined ? {} : { cookie }) },
      payload: { identifier: "admin", password },
    });
  const whoAmI = (cookie: string) => callRoute(test, routes.getSession, { cookie });
  const expectSignedOut = async (cookie: string) => expectProblem(await whoAmI(cookie), 401, problemTypes.signInRequired);
  const expectSignedIn = async (cookie: string) => expect((await whoAmI(cookie)).statusCode).toBe(200);
  const changePassword = (cookie: string, currentPassword = goodPassword) =>
    callRoute(test, routes.changePassword, { cookie, payload: { currentPassword, newPassword } });
  /** Keeps the session in use every `step` until `total` has passed. */
  const keepUsing = async (cookie: string, total: number, step: number) => {
    for (let passed = 0; passed + step <= total; passed += step) {
      test.clock.advance(step);
      await expectSignedIn(cookie);
    }
  };

  describe("the cookie", () => {
    it("is __Host-nu_session: Secure, HttpOnly, SameSite=Strict, Path=/, with no Max-Age, Expires or Domain", async () => {
      const response = await signInResponse();
      expect(response.statusCode).toBe(200);
      const cookie = setCookieOf(response);
      const [pair, ...attributes] = cookie.split(";").map((part) => part.trim());
      expect(pair).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
      expect(SESSION_COOKIE).toBe("__Host-nu_session");
      expect(attributes.toSorted()).toEqual(["HttpOnly", "Path=/", "SameSite=Strict", "Secure"]);
      expect(cookie).not.toMatch(/max-age|expires|domain/i);
    });

    it("is cleared at sign-out, which revokes the session server-side", async () => {
      const cookie = await test.signIn("admin");
      const response = await callRoute(test, routes.signOut, { cookie });
      expect(response.statusCode).toBe(204);
      expect(setCookieOf(response)).toBe(`${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
      // The browser forgetting the cookie isn't what ends it: the same cookie no longer works.
      await expectSignedOut(cookie);
      expect(tableRows(test, "sessions")).toEqual([expect.objectContaining({ revoked_at: test.clock.now().toISOString() })]);
      expect(test.audited("sign-out")).toEqual([
        expect.objectContaining({ actorUsername: "admin", targetKind: "session", targetId: tableRows(test, "sessions")[0]?.["id"] }),
      ]);
    });

    it("reads only a well-formed token from the Cookie header", () => {
      const token = "x".repeat(43);
      expect(readSessionToken(undefined)).toBeUndefined();
      expect(readSessionToken(`other=1; ${SESSION_COOKIE}=${token}`)).toBe(token);
      expect(readSessionToken(`${SESSION_COOKIE}=short; ${SESSION_COOKIE}=${token}`)).toBe(token);
      expect(readSessionToken(`nu_session=${token}`)).toBeUndefined();
      expect(readSessionToken(`${SESSION_COOKIE}=${token}!`)).toBeUndefined();
    });
  });

  describe("storage", () => {
    it("stores session and setup tokens only as their SHA-256", async () => {
      const setupToken = test.issueSetupToken("admin-reset").token;
      const cookie = await test.signIn("admin");
      const token = cookie.slice(SESSION_COOKIE.length + 1);
      const sessionRows = tableRows(test, "sessions");
      expect(sessionRows).toEqual([expect.objectContaining({ token_hash: hashToken(token), user_id: admin.id, state: "active" })]);
      expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
      expect(tableRows(test, "setup_tokens")).toEqual([expect.objectContaining({ token_hash: hashToken(setupToken) })]);

      const everything = JSON.stringify([sessionRows, tableRows(test, "setup_tokens"), tableRows(test, "audit_events")]);
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(setupToken);
      expect(JSON.stringify(test.logs())).not.toContain(token);
    });
  });

  describe("rotation", () => {
    it("gives a new token at sign-in and ends the browser's earlier session", async () => {
      const first = await test.signIn("admin");
      const response = await signInResponse(goodPassword, first);
      const second = sessionCookieHeader(sessionTokenFrom(response));
      expect(second).not.toBe(first);
      await expectSignedOut(first);
      await expectSignedIn(second);
    });

    it("gives a new token on confirm; the old one gets 401", async () => {
      const before = await test.signIn("admin");
      const response = await callRoute(test, routes.confirmSession, { cookie: before, payload: { password: goodPassword } });
      expect(response.statusCode).toBe(200);
      const after = sessionCookieHeader(sessionTokenFrom(response));
      expect(after).not.toBe(before);
      await expectSignedOut(before);
      await expectSignedIn(after);
      expect(tableRows(test, "sessions")).toHaveLength(1);
    });

    it("keeps the token when confirm fails", async () => {
      const cookie = await test.signIn("admin");
      const response = await callRoute(test, routes.confirmSession, { cookie, payload: { password: "not the password at all" } });
      expectProblem(response, 401, problemTypes.signInFailed);
      expect(response.headers["set-cookie"]).toBeUndefined();
      await expectSignedIn(cookie);
    });
  });

  describe("password change", () => {
    it("rotates the token, signs out the admin's other sessions and records password.changed", async () => {
      const current = await test.signIn("admin");
      const other = await test.signIn("admin");
      const third = test.startSession(admin);

      const response = await changePassword(current);
      expect(response.statusCode).toBe(204);
      const rotated = sessionCookieHeader(sessionTokenFrom(response));

      await expectSignedOut(current);
      await expectSignedOut(other);
      await expectSignedOut(third);
      await expectSignedIn(rotated);

      expect(test.audited("password.changed")).toEqual([
        expect.objectContaining({ actorUsername: "admin", targetId: admin.id, details: { revokedSessions: 2 } }),
      ]);
      expect(test.audited("session.revoked").map((event) => event.details)).toEqual([
        expect.objectContaining({ reason: "password-changed" }),
        expect.objectContaining({ reason: "password-changed" }),
      ]);
      await expect(test.signIn("admin", newPassword)).resolves.toMatch(/^__Host-nu_session=/);
      await expect(test.signIn("admin", goodPassword)).rejects.toThrow(/401/);
    });

    it("changes nothing with a wrong current password", async () => {
      const current = await test.signIn("admin");
      const other = await test.signIn("admin");
      expectProblem(await changePassword(other, "not the current password"), 401, problemTypes.signInFailed);
      await expectSignedIn(other);
      expect(test.audited("password.changed")).toEqual([]);
      void current;
    });
  });

  describe("revocation", () => {
    it("revokes one session by id, server-side, and records session.revoked", async () => {
      const mine = await test.signIn("admin");
      const other = await test.signIn("admin");
      const list = await callRoute(test, routes.listSessions, { cookie: mine });
      expect(list.statusCode).toBe(200);
      const { sessions } = list.json<{ sessions: { id: string; current: boolean }[] }>();
      expect(sessions).toHaveLength(2);
      const otherId = sessions.find((session) => !session.current)?.id ?? "";

      const response = await callRoute(test, routes.revokeSession, { cookie: mine, params: otherId });
      expect(response.statusCode).toBe(204);
      expect(response.headers["set-cookie"]).toBeUndefined();
      await expectSignedOut(other);
      await expectSignedIn(mine);
      expect(test.audited("session.revoked")).toEqual([
        expect.objectContaining({
          actorUsername: "admin",
          targetId: otherId,
          details: { sessionId: otherId, reason: "signed-out-elsewhere" },
        }),
      ]);
      // Gone already: the same 404 as an unknown session.
      expectProblem(await callRoute(test, routes.revokeSession, { cookie: mine, params: otherId }), 404, problemTypes.notFound);
    });

    it("revokes the caller's own session and clears its cookie", async () => {
      const mine = await test.signIn("admin");
      const [session] = tableRows(test, "sessions");
      const response = await callRoute(test, routes.revokeSession, { cookie: mine, params: String(session?.["id"]) });
      expect(response.statusCode).toBe(204);
      expect(setCookieOf(response)).toMatch(/Max-Age=0/);
      await expectSignedOut(mine);
    });

    it("answers 404 for another account's session and leaves it alone", async () => {
      const user = test.createUser();
      const userCookie = test.startSession(user);
      const userSession = tableRows(test, "sessions").find((row) => row["user_id"] === user.id);
      const mine = await test.signIn("admin");
      const response = await callRoute(test, routes.revokeSession, { cookie: mine, params: String(userSession?.["id"]) });
      expectProblem(response, 404, problemTypes.notFound);
      await expectSignedIn(userCookie);
    });

    it("revokes every other session of the account, and no one else's", async () => {
      const user = test.createUser();
      const userCookie = test.startSession(user);
      const mine = await test.signIn("admin");
      const others = [await test.signIn("admin"), test.startSession(admin)];

      const response = await callRoute(test, routes.revokeOtherSessions, { cookie: mine });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ revoked: 2 });
      for (const cookie of others) await expectSignedOut(cookie);
      await expectSignedIn(mine);
      await expectSignedIn(userCookie);
      expect(test.audited("session.revoked").map((event) => event.details["reason"])).toEqual(["signed-out-others", "signed-out-others"]);
    });
  });

  describe("timeouts", () => {
    it("ends an admin session after 30 minutes idle", async () => {
      const cookie = test.startSession(admin);
      test.clock.advance(30 * MINUTE_MS - 1);
      await expectSignedIn(cookie);
      test.clock.advance(30 * MINUTE_MS);
      await expectSignedOut(cookie);
    });

    it("ends an admin session 12 hours after sign-in however busy", async () => {
      const cookie = test.startSession(admin);
      await keepUsing(cookie, 12 * HOUR_MS - 20 * MINUTE_MS, 20 * MINUTE_MS);
      test.clock.advance(20 * MINUTE_MS - 1);
      await expectSignedIn(cookie);
      test.clock.advance(1);
      await expectSignedOut(cookie);
    });

    it("ends a user session after 2 hours idle, and 7 days after sign-in", async () => {
      const user = test.createUser();
      const idle = test.startSession(user);
      test.clock.advance(2 * HOUR_MS - 1);
      await expectSignedIn(idle);
      test.clock.advance(2 * HOUR_MS);
      await expectSignedOut(idle);

      const busy = test.startSession(user);
      await keepUsing(busy, 7 * 24 * HOUR_MS - HOUR_MS, HOUR_MS);
      test.clock.advance(HOUR_MS - 1);
      await expectSignedIn(busy);
      test.clock.advance(1);
      await expectSignedOut(busy);
    });

    it("takes the timeouts from the settings", async () => {
      test.settings.set(
        "sessionTimeouts",
        { admin: { idleMinutes: 5, absoluteHours: 1 }, user: { idleMinutes: 10, absoluteHours: 2 } },
        admin.id,
      );
      const adminCookie = test.startSession(admin);
      const userCookie = test.startSession(test.createUser());
      test.clock.advance(5 * MINUTE_MS);
      await expectSignedOut(adminCookie);
      await expectSignedIn(userCookie);
      test.clock.advance(10 * MINUTE_MS);
      await expectSignedOut(userCookie);
    });

    it("ends a session waiting for its second factor after 5 minutes", async () => {
      const cookie = test.startSession(admin, { state: "pendingSecondFactor", recentSignIn: false });
      test.clock.advance(5 * MINUTE_MS - 1);
      await expectSignedIn(cookie);
      test.clock.advance(1);
      await expectSignedOut(cookie);
    });

    it("lists only live sessions", async () => {
      const old = test.startSession(admin);
      test.clock.advance(20 * MINUTE_MS);
      const fresh = test.startSession(admin);
      test.clock.advance(15 * MINUTE_MS);
      const response = await callRoute(test, routes.listSessions, { cookie: fresh });
      expect(response.json<{ sessions: unknown[] }>().sessions).toHaveLength(1);
      void old;
    });
  });

  describe("last seen", () => {
    it("writes last_seen_at at most once a minute", async () => {
      const cookie = test.startSession(admin);
      const started = test.clock.now().toISOString();
      const lastSeen = () => tableRows(test, "sessions")[0]?.["last_seen_at"];

      test.clock.advance(MINUTE_MS - 1);
      await expectSignedIn(cookie);
      expect(lastSeen()).toBe(started);

      test.clock.advance(1);
      await expectSignedIn(cookie);
      const touched = test.clock.now().toISOString();
      expect(lastSeen()).toBe(touched);

      test.clock.advance(30_000);
      await expectSignedIn(cookie);
      expect(lastSeen()).toBe(touched);
    });
  });
});
