import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../../test-support/index.ts";

describe("the accounts service", () => {
  let test: TestApp;

  beforeEach(async () => {
    test = await buildTestApp();
  });
  afterEach(() => test.close());

  it("counts the users by status, never the admin", async () => {
    expect(test.services.accounts.countUsers()).toEqual({ active: 0, disabled: 0 });
    await test.createAdmin();
    test.createUser({ username: "alice" });
    test.createUser({ username: "bob" });
    const carol = test.createUser({ username: "carol" });
    expect(test.services.accounts.countUsers()).toEqual({ active: 3, disabled: 0 });

    test.services.accounts.setStatus(carol.id, "disabled");
    expect(test.services.accounts.countUsers()).toEqual({ active: 2, disabled: 1 });
    const listed = test.services.accounts.listUsers().map((user) => [user.username, user.status]);
    expect(listed.toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["alice", "active"],
      ["bob", "active"],
      ["carol", "disabled"],
    ]);
  });
});
