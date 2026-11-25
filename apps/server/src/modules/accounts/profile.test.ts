import { problemTypes, routes } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_SIGN_IN_MS } from "../../http/index.ts";
import { buildTestApp, expectProblem, type TestApp } from "../../test-support/index.ts";
import { callRoute } from "../../test-support/sessions.ts";
import type { AccountRecord } from "./index.ts";

describe("the profile routes", () => {
  let test: TestApp;
  let admin: AccountRecord;
  let cookie: string;

  beforeEach(async () => {
    test = await buildTestApp();
    admin = await test.createAdmin();
    cookie = await test.signIn("admin");
  });
  afterEach(() => test.close());

  const update = (payload: object, as = cookie) => callRoute(test, routes.updateProfile, { cookie: as, payload });

  it("changes the display name and email, and records account.changed with the fields only", async () => {
    const response = await update({ displayName: "Head Admin", email: "Head@Example.com" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: admin.id,
      username: "admin",
      email: "head@example.com",
      displayName: "Head Admin",
      role: "admin",
    });
    expect((await callRoute(test, routes.getProfile, { cookie })).json()).toMatchObject({ email: "head@example.com" });
    expect(test.audited("account.changed")).toEqual([
      expect.objectContaining({
        actorUsername: "admin",
        targetKind: "account",
        targetId: admin.id,
        details: { fields: ["email", "displayName"] },
      }),
    ]);
    expect(JSON.stringify(test.audited("account.changed"))).not.toContain("head@example.com");
  });

  it("records nothing when nothing changes", async () => {
    expect((await update({ displayName: admin.displayName })).statusCode).toBe(200);
    expect(test.audited("account.changed")).toEqual([]);
  });

  it("needs a recent sign-in to change the email, not the display name", async () => {
    test.clock.advance(RECENT_SIGN_IN_MS);
    expectProblem(await update({ email: "new@example.com" }), 403, problemTypes.recentSignInRequired);
    expect((await update({ displayName: "Still Fine" })).statusCode).toBe(200);
    expect(test.audited("account.changed")).toEqual([expect.objectContaining({ details: { fields: ["displayName"] } })]);
  });

  it("lets a user change their own profile", async () => {
    const user = test.createUser();
    const userCookie = test.startSession(user);
    const response = await update({ displayName: "Renamed User" }, userCookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, role: "user", displayName: "Renamed User" });
    expect(test.audited("account.changed")).toEqual([expect.objectContaining({ actorUsername: "user", targetId: user.id })]);
  });

  it("refuses an email another account uses", async () => {
    test.createUser({ email: "taken@example.com" });
    expectProblem(await update({ email: "TAKEN@example.com" }), 422, problemTypes.validationFailed);
  });
});
