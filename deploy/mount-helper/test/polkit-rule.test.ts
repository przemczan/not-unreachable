import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Rule = (action: { id: string; lookup: (key: string) => string | undefined }, subject: { user: string }) => unknown;

const YES = Symbol("yes");
const UNIT = "not-unreachable-mount@0b6e7a2c-4f1d-4c3e-9a8b-5d6c7e8f9a0b.service";
const MANAGE_UNITS = "org.freedesktop.systemd1.manage-units";

async function loadRule(): Promise<Rule> {
  const rules: Rule[] = [];
  const source = await readFile(new URL("../../polkit/50-not-unreachable.rules", import.meta.url), "utf8");
  runInNewContext(source, { polkit: { addRule: (rule: Rule) => rules.push(rule), Result: { YES } } });
  const [rule, ...others] = rules;
  if (rule === undefined || others.length > 0) throw new Error("The rules file must add exactly one rule");
  return rule;
}

async function decide(unit: string, verb: string, user = "not-unreachable", id = MANAGE_UNITS): Promise<unknown> {
  const rule = await loadRule();
  return rule(
    {
      id,
      lookup: (key) =>
        new Map([
          ["unit", unit],
          ["verb", verb],
        ]).get(key),
    },
    { user },
  );
}

describe("the polkit rule", () => {
  it.each(["start", "stop"])("allows the service user to %s a mount unit", async (verb) => {
    expect(await decide(UNIT, verb)).toBe(YES);
  });

  it.each([
    "not-unreachable.service",
    "not-unreachable-mount@x.service",
    "not-unreachable-mount@.service",
    // 36 characters of [0-9a-f-], but not a UUID.
    `not-unreachable-mount@${"-".repeat(36)}.service`,
    `not-unreachable-mount@${"0".repeat(36)}.service`,
    "not-unreachable-mount@0b6e7a2c4f1d-4c3e-9a8b-5d6c7e8f9a0b-.service",
    "ssh.service",
    `${UNIT}.d`,
    `x${UNIT}`,
    UNIT.replace("0b6e", "0B6E"),
    UNIT.replace(".service", ".mount"),
  ])("falls through for %s", async (unit) => {
    expect(await decide(unit, "start")).toBeUndefined();
  });

  it.each(["restart", "try-restart", "reload-or-restart", "reset-failed", "enable", "disable", "kill", "reload", "mask", "set-property"])(
    "falls through for the verb %s",
    async (verb) => {
      expect(await decide(UNIT, verb)).toBeUndefined();
    },
  );

  // StartTransientUnit asks with the unit's name too; a unit without details must never match.
  it("falls through when systemd names no unit or verb", async () => {
    const rule = await loadRule();
    expect(rule({ id: MANAGE_UNITS, lookup: () => undefined }, { user: "not-unreachable" })).toBeUndefined();
  });

  it.each(["root", "alice", "not-unreachable-x"])("falls through for the user %s", async (user) => {
    expect(await decide(UNIT, "start", user)).toBeUndefined();
  });

  it.each(["org.freedesktop.systemd1.manage-unit-files", "org.freedesktop.systemd1.reload-daemon", "org.freedesktop.login1.reboot"])(
    "falls through for the action %s",
    async (action) => {
      expect(await decide(UNIT, "start", "not-unreachable", action)).toBeUndefined();
    },
  );
});
