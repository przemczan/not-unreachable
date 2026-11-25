import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test-support/index.ts";
import { createSystemctlMountRunner, MOUNT_TIMEOUT_MS, mountUnit, type ExecFileFunction, type ExecResult } from "./index.ts";

const ID = "01900000-0000-7000-8000-0000000000ab";
const UNIT = `not-unreachable-mount@${ID}.service`;

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** A fake exec answering `start`/`stop`/`is-active` with `answer`, and `show` with the helper's status. */
function fakeExec(answer: ExecResult, helperStatus = "0\n"): { readonly exec: ExecFileFunction; readonly calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFileFunction = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs });
    if (args[0] === "show") return { kind: "exited", code: 0, stdout: helperStatus };
    // The stop after a timeout succeeds.
    if (args[1] === "stop" && calls.some((call) => call.args[1] === "start")) return { kind: "exited", code: 0, stdout: "" };
    return answer;
  };
  return { exec, calls };
}

const failedStart: ExecResult = { kind: "exited", code: 1, stdout: "" };

/** A runner over a fake exec, with its calls and log. */
const runnerWith = (answer: ExecResult, helperStatus?: string) => {
  const fake = fakeExec(answer, helperStatus);
  const captured = captureLogger("info");
  return {
    runner: createSystemctlMountRunner({ logger: captured.logger, systemctl: "/bin/systemctl", execFile: fake.exec }),
    calls: fake.calls,
    logs: captured.lines,
  };
};

describe("the systemctl mount runner", () => {
  it("starts, stops and asks about the unit with argument arrays and a 30 s timeout", async () => {
    const { runner, calls } = runnerWith({ kind: "exited", code: 0, stdout: "" });
    expect(await runner.start(ID)).toEqual({ ok: true });
    expect(await runner.stop(ID)).toEqual({ ok: true });
    expect(await runner.isActive(ID)).toBe(true);
    expect(calls).toEqual([
      { file: "/bin/systemctl", args: ["--no-ask-password", "start", UNIT], timeoutMs: MOUNT_TIMEOUT_MS },
      { file: "/bin/systemctl", args: ["--no-ask-password", "stop", UNIT], timeoutMs: MOUNT_TIMEOUT_MS },
      { file: "/bin/systemctl", args: ["is-active", UNIT], timeoutMs: MOUNT_TIMEOUT_MS },
    ]);
    expect(MOUNT_TIMEOUT_MS).toBe(30_000);
  });

  it.each([
    ["10", "auth"],
    ["11", "unreachable"],
    ["12", "no-share"],
    ["13", "not-supported"],
    ["14", "mount-failed"],
    ["1", "mount-failed"],
    ["4", "mount-failed"],
  ] as const)("maps the helper's exit code %s to %s", async (status, reason) => {
    const { runner, calls } = runnerWith(failedStart, `${status}\n`);
    expect(await runner.start(ID)).toEqual({ ok: false, reason });
    expect(calls[1]?.args).toEqual(["show", "-p", "ExecMainStatus", "--value", UNIT]);
  });

  it("warns about a request the helper refused (an app bug or tampering)", async () => {
    const { runner, logs } = runnerWith(failedStart, "5\n");
    await runner.start(ID);
    expect(logs()).toContainEqual(expect.objectContaining({ level: 40, unit: UNIT, status: 5 }));
  });

  it("answers helper-unavailable when systemd never ran the helper or systemctl is missing", async () => {
    expect(await runnerWith(failedStart, "0\n").runner.start(ID)).toEqual({ ok: false, reason: "helper-unavailable" });
    expect(await runnerWith(failedStart, "\n").runner.start(ID)).toEqual({ ok: false, reason: "helper-unavailable" });
    expect(await runnerWith({ kind: "not-started" }).runner.start(ID)).toEqual({ ok: false, reason: "helper-unavailable" });
    expect(await runnerWith({ kind: "not-started" }).runner.stop(ID)).toEqual({ ok: false, reason: "helper-unavailable" });
    expect(await runnerWith({ kind: "not-started" }).runner.isActive(ID)).toBe(false);
  });

  it("answers unreachable on the timeout and stops the unit so it doesn't linger", async () => {
    const { runner, calls } = runnerWith({ kind: "timed-out" });
    expect(await runner.start(ID)).toEqual({ ok: false, reason: "unreachable" });
    expect(calls.map((call) => call.args)).toEqual([
      ["--no-ask-password", "start", UNIT],
      ["--no-ask-password", "stop", UNIT],
    ]);
  });

  it("reports a failed stop and an inactive unit", async () => {
    const { runner } = runnerWith({ kind: "exited", code: 3, stdout: "inactive\n" });
    expect(await runner.isActive(ID)).toBe(false);
    expect(await runner.stop(ID)).toEqual({ ok: false, reason: "mount-failed" });
  });

  it("refuses an id that isn't a UUID before it reaches a unit name", async () => {
    expect(mountUnit(ID)).toBe(UNIT);
    for (const id of ["../etc", "x", `${ID}.service`, ID.toUpperCase()])
      expect(() => mountUnit(id)).toThrow("A mount id must be a lower-case UUID");
    const { runner, calls } = runnerWith({ kind: "exited", code: 0, stdout: "" });
    await expect(runner.start("foo bar")).rejects.toThrow("A mount id must be a lower-case UUID");
    expect(calls).toEqual([]);
  });
});
