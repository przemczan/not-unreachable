import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Rule = (action: { id: string; lookup: (key: string) => string | undefined }, subject: { user: string }) => unknown;

const YES = Symbol("yes");
const UNIT = "not-unreachable-allow-folder.service";
const MANAGE_UNITS = "org.freedesktop.systemd1.manage-units";

async function loadRule(file: string): Promise<Rule> {
  const rules: Rule[] = [];
  const source = await readFile(new URL(`../../polkit/${file}`, import.meta.url), "utf8");
  runInNewContext(source, { polkit: { addRule: (rule: Rule) => rules.push(rule), Result: { YES } } });
  const [rule, ...others] = rules;
  if (rule === undefined || others.length > 0) throw new Error("The rules file must add exactly one rule");
  return rule;
}

async function decide(
  unit: string,
  verb: string,
  { user = "not-unreachable", id = MANAGE_UNITS, file = "51-not-unreachable-allow-folder.rules" } = {},
): Promise<unknown> {
  const rule = await loadRule(file);
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

describe("the allow-folder polkit rule", () => {
  it("allows the service user to start the folder helper's unit", async () => {
    expect(await decide(UNIT, "start")).toBe(YES);
  });

  it.each([
    "stop",
    "restart",
    "try-restart",
    "reload-or-restart",
    "reset-failed",
    "enable",
    "disable",
    "kill",
    "reload",
    "mask",
    "set-property",
  ])("falls through for the verb %s", async (verb) => {
    expect(await decide(UNIT, verb)).toBeUndefined();
  });

  it.each([
    "not-unreachable.service",
    "not-unreachable-mount@0b6e7a2c-4f1d-4c3e-9a8b-5d6c7e8f9a0b.service",
    "not-unreachable-allow-folder@x.service",
    "not-unreachable-allow-folder.service.d",
    "not-unreachable-allow-folder.timer",
    `x${UNIT}`,
    UNIT.toUpperCase(),
    "ssh.service",
  ])("falls through for %s", async (unit) => {
    expect(await decide(unit, "start")).toBeUndefined();
  });

  it("falls through when systemd names no unit or verb", async () => {
    const rule = await loadRule("51-not-unreachable-allow-folder.rules");
    expect(rule({ id: MANAGE_UNITS, lookup: () => undefined }, { user: "not-unreachable" })).toBeUndefined();
  });

  it.each(["root", "alice", "not-unreachable-x"])("falls through for the user %s", async (user) => {
    expect(await decide(UNIT, "start", { user })).toBeUndefined();
  });

  it.each(["org.freedesktop.systemd1.manage-unit-files", "org.freedesktop.systemd1.reload-daemon", "org.freedesktop.login1.reboot"])(
    "falls through for the action %s",
    async (id) => {
      expect(await decide(UNIT, "start", { id })).toBeUndefined();
    },
  );

  // The unit is allowed by its own file only, so removing that file is all it takes to switch it off.
  it("is not allowed by the mount rule", async () => {
    expect(await decide(UNIT, "start", { file: "50-not-unreachable.rules" })).toBeUndefined();
  });
});
