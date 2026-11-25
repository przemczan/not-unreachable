import { problemTypes, routes } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, expectProblem, goodPassword, sameOriginWrite, viaProxy, type TestApp } from "../../test-support/index.ts";
import { hashToken } from "../platform/index.ts";
import { AdminExistsError, NoAdminError, SETUP_TOKEN_LIFETIME_MS } from "./index.ts";

const firstRun = (token: string, password = goodPassword) => ({
  token,
  username: "root.admin",
  email: "Admin@Example.com",
  displayName: "Root Admin",
  password,
});

describe("setup", () => {
  let test: TestApp;

  beforeEach(async () => {
    test = await buildTestApp();
  });
  afterEach(() => test.close());

  const status = async () => (await test.app.inject({ method: "GET", url: routes.setupStatus.path, headers: viaProxy })).json();
  const post = (payload: object) => test.app.inject({ method: "POST", url: routes.setup.path, headers: sameOriginWrite, payload });
  const rows = (table: string) => test.database.sqlite.prepare(`SELECT * FROM ${table}`).all();

  it("creates the admin on first run with a first-run token, then answers 404 for good", async () => {
    expect(await status()).toEqual({ adminExists: false });
    const { token } = test.issueSetupToken("first-run");

    const response = await post(firstRun(token));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ username: "root.admin" });

    const [admin] = rows("users");
    expect(admin).toMatchObject({
      username: "root.admin",
      email: "admin@example.com",
      display_name: "Root Admin",
      role: "admin",
      status: "active",
      quota_bytes: null,
    });
    expect(rows("password_credentials")).toEqual([expect.objectContaining({ hash: expect.stringMatching(/^\$argon2id\$/) })]);
    expect(await status()).toEqual({ adminExists: true });

    const completed = test.audited("setup.completed");
    expect(completed).toEqual([
      expect.objectContaining({
        actorKind: "account",
        actorUsername: "root.admin",
        outcome: "succeeded",
        details: { purpose: "first-run" },
      }),
    ]);
    expect(test.audited("setup-link.issued")).toEqual([
      expect.objectContaining({ actorKind: "system", details: expect.objectContaining({ purpose: "first-run" }) }),
    ]);

    expectProblem(await post(firstRun(token)), 404, problemTypes.notFound);
    expect(() => test.issueSetupToken("first-run")).toThrow(AdminExistsError);
    await expect(test.signIn("root.admin")).resolves.toMatch(/^__Host-nu_session=/);
  });

  it("stores only the token's SHA-256", () => {
    const { token, expiresAt } = test.issueSetupToken("first-run");
    expect(rows("setup_tokens")).toEqual([
      expect.objectContaining({ purpose: "first-run", token_hash: hashToken(token), user_id: null, used_at: null, expires_at: expiresAt }),
    ]);
    expect(JSON.stringify(rows("setup_tokens"))).not.toContain(token);
  });

  it("expires a token after an hour", async () => {
    const expired = test.issueSetupToken("first-run").token;
    test.clock.advance(SETUP_TOKEN_LIFETIME_MS);
    expectProblem(await post(firstRun(expired)), 404, problemTypes.notFound);

    const fresh = test.issueSetupToken("first-run").token;
    test.clock.advance(SETUP_TOKEN_LIFETIME_MS - 1);
    expect((await post(firstRun(fresh))).statusCode).toBe(200);
  });

  it("replaces an earlier unused token when it issues a new one", async () => {
    const first = test.issueSetupToken("first-run").token;
    const second = test.issueSetupToken("first-run").token;
    expectProblem(await post(firstRun(first)), 404, problemTypes.notFound);
    expect((await post(firstRun(second))).statusCode).toBe(200);
  });

  it("checks the password before it uses the token", async () => {
    const { token } = test.issueSetupToken("first-run");
    expectProblem(await post(firstRun(token, "qwertyuiop123")), 422, problemTypes.breachedPassword);
    expectProblem(await post(firstRun(token, "too short")), 400, problemTypes.validationFailed);
    expect(rows("users")).toEqual([]);
    expect((await post(firstRun(token))).statusCode).toBe(200);
  });

  it("answers every invalid token or body with the same 404", async () => {
    const unknown = "A".repeat(43);
    const bodies = [await post(firstRun(unknown)), await post({ token: test.issueSetupToken("first-run").token, password: goodPassword })];
    await test.createAdmin();
    const reset = test.issueSetupToken("admin-reset").token;
    bodies.push(await post(firstRun(reset)), await post({ token: unknown, password: goodPassword }));
    for (const response of bodies) expectProblem(response, 404, problemTypes.notFound);
    expect(new Set(bodies.map((response) => response.body)).size).toBe(1);
  });

  it("sets the admin's new password with an admin-reset token, once", async () => {
    expect(() => test.issueSetupToken("admin-reset")).toThrow(NoAdminError);
    const admin = await test.createAdmin();
    const { token } = test.issueSetupToken("admin-reset");
    expect(rows("setup_tokens")).toEqual([expect.objectContaining({ purpose: "admin-reset", user_id: admin.id })]);

    const newPassword = "a brand new admin password";
    const response = await post({ token, password: newPassword });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ username: "admin" });
    await expect(test.signIn("admin", newPassword)).resolves.toMatch(/^__Host-nu_session=/);
    await expect(test.signIn("admin", goodPassword)).rejects.toThrow(/401/);
    expect(test.audited("setup.completed")).toEqual([
      expect.objectContaining({ actorUsername: "admin", details: { purpose: "admin-reset" } }),
    ]);

    expectProblem(await post({ token, password: "yet another admin password" }), 404, problemTypes.notFound);
  });
});
