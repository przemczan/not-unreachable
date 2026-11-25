import { problemTypes, routes, type SecuritySettings } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_SIGN_IN_MS } from "../../http/index.ts";
import { buildTestApp, expectProblem, type TestApp } from "../../test-support/index.ts";
import { callRoute } from "../../test-support/sessions.ts";
import { MINUTE_MS } from "../platform/index.ts";

describe("the Security settings routes", () => {
  let test: TestApp;
  let cookie: string;

  beforeEach(async () => {
    test = await buildTestApp();
    cookie = await test.signIn((await test.createAdmin()).username);
  });
  afterEach(() => test.close());

  const read = async (): Promise<SecuritySettings> => (await callRoute(test, routes.getSecuritySettings, { cookie })).json();

  it("reads the defaults", async () => {
    expect(await read()).toEqual({
      sessionTimeouts: { admin: { idleMinutes: 30, absoluteHours: 12 }, user: { idleMinutes: 120, absoluteHours: 168 } },
      signInLimits: { perIpPerMinute: 10, perIpPerHour: 50, delayAfterFailures: 5, lockAfterFailures: 20, lockMinutes: 15 },
      auditRetentionDays: 365,
    });
  });

  it("stores a change, records settings.changed with the changed keys only, and applies the new timeouts", async () => {
    const changed: SecuritySettings = {
      ...(await read()),
      sessionTimeouts: { admin: { idleMinutes: 5, absoluteHours: 1 }, user: { idleMinutes: 120, absoluteHours: 168 } },
    };
    const response = await callRoute(test, routes.updateSecuritySettings, { cookie, payload: changed });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(changed);
    expect(await read()).toEqual(changed);

    expect(test.audited("settings.changed")).toEqual([
      expect.objectContaining({
        actorKind: "account",
        actorUsername: "admin",
        outcome: "succeeded",
        details: { keys: ["sessionTimeouts"] },
      }),
    ]);

    // The same values again change nothing and record nothing.
    expect((await callRoute(test, routes.updateSecuritySettings, { cookie, payload: changed })).statusCode).toBe(200);
    expect(test.audited("settings.changed")).toHaveLength(1);

    test.clock.advance(5 * MINUTE_MS);
    expectProblem(await callRoute(test, routes.getSecuritySettings, { cookie }), 401, problemTypes.signInRequired);
  });

  it("needs a recent sign-in to change them", async () => {
    const values = await read();
    test.clock.advance(RECENT_SIGN_IN_MS);
    expectProblem(
      await callRoute(test, routes.updateSecuritySettings, { cookie, payload: values }),
      403,
      problemTypes.recentSignInRequired,
    );
    expect(test.audited("settings.changed")).toEqual([]);
  });

  it("refuses values out of range", async () => {
    const values = { ...(await read()), auditRetentionDays: 1 };
    expectProblem(await callRoute(test, routes.updateSecuritySettings, { cookie, payload: values }), 400, problemTypes.validationFailed);
  });
});
