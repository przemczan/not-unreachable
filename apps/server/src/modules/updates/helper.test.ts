import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test-support/index.ts";
import type { ExecFileFunction, ExecResult } from "../resources/index.ts";
import { createSystemctlUpdateHelper, VERIFY_EXIT_REASONS, VERIFY_TIMEOUT_MS, VERIFY_UNIT } from "./index.ts";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** A fake exec answering `start` with `answer`, and `show` with the unit's exit status. */
function helperWith(answer: ExecResult, unitStatus = "0\n") {
  const calls: Call[] = [];
  const exec: ExecFileFunction = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs });
    if (args[0] === "show") return { kind: "exited", code: 0, stdout: unitStatus };
    return answer;
  };
  const captured = captureLogger("info");
  return {
    helper: createSystemctlUpdateHelper({ logger: captured.logger, systemctl: "/bin/systemctl", execFile: exec }),
    calls,
    logs: captured.lines,
  };
}

/** A fake exec answering `show` with `answer`, and recording what it was asked. */
function helperShowing(answer: ExecResult) {
  const calls: Call[] = [];
  const exec: ExecFileFunction = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs });
    return answer;
  };
  const helper = createSystemctlUpdateHelper({ logger: captureLogger("info").logger, systemctl: "/bin/systemctl", execFile: exec });
  return { helper, calls };
}

const failedStart: ExecResult = { kind: "exited", code: 1, stdout: "" };

describe("the systemctl update helper", () => {
  it("starts exactly the verify unit with an argument array, never asking for a password", async () => {
    const { helper, calls } = helperWith({ kind: "exited", code: 0, stdout: "" });
    expect(await helper.verify()).toEqual({ ok: true });
    expect(calls).toEqual([{ file: "/bin/systemctl", args: ["--no-ask-password", "start", VERIFY_UNIT], timeoutMs: VERIFY_TIMEOUT_MS }]);
    expect(VERIFY_UNIT).toBe("not-unreachable-update.service");
  });

  it.each([
    ["1", "internal"],
    ["2", "internal"],
    ["3", "request-invalid"],
    ["4", "request-invalid"],
    ["5", "request-invalid"],
    ["6", "switch-off"],
    ["7", "internal"],
    ["8", "busy"],
    ["9", "interrupted"],
    ["20", "download-incomplete"],
    ["21", "download-incomplete"],
    ["22", "unsigned"],
    ["23", "signature-invalid"],
    ["24", "checksum-mismatch"],
    ["25", "version-mismatch"],
    ["26", "not-newer"],
    ["27", "archive-unsafe"],
    ["28", "archive-invalid"],
    ["29", "needs-installer"],
    ["30", "systemd-failed"],
    ["31", "no-space"],
    ["99", "internal"],
  ] as const)("maps the unit's exit code %s to %s", async (status, reason) => {
    const { helper, calls } = helperWith(failedStart, `${status}\n`);
    expect(await helper.verify()).toEqual({ ok: false, reason });
    expect(calls[1]?.args).toEqual(["show", "-p", "ExecMainStatus", "--value", VERIFY_UNIT]);
  });

  it("knows every exit code of the design's table", () => {
    expect([...VERIFY_EXIT_REASONS.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
  });

  it("answers switch-off when systemd never ran the unit (polkit refused it)", async () => {
    const { helper, logs } = helperWith(failedStart, "0\n");
    expect(await helper.verify()).toEqual({ ok: false, reason: "switch-off" });
    expect(logs()).toContainEqual(expect.objectContaining({ msg: expect.stringContaining("isn't set up") }));
  });

  it("answers internal when systemctl can't run or times out; a status it can't read counts as never run", async () => {
    expect(await helperWith({ kind: "not-started" }).helper.verify()).toEqual({ ok: false, reason: "internal" });
    expect(await helperWith({ kind: "timed-out" }).helper.verify()).toEqual({ ok: false, reason: "internal" });
    expect(await helperWith(failedStart, "garbage\n").helper.verify()).toEqual({ ok: false, reason: "switch-off" });
  });

  it("asks systemd for the verify unit's ActiveState with an argument array", async () => {
    const { helper, calls } = helperShowing({ kind: "exited", code: 0, stdout: "inactive\n" });
    await helper.isRunning();
    expect(calls).toEqual([
      { file: "/bin/systemctl", args: ["show", "-p", "ActiveState", "--value", VERIFY_UNIT], timeoutMs: expect.any(Number) },
    ]);
  });

  it.each([
    ["active", true],
    ["activating", true],
    ["deactivating", true],
    ["reloading", true],
    ["inactive", false],
    ["failed", false],
    ["", false],
    ["something-new", false],
  ])("answers isRunning for the ActiveState %j: %s", async (state, running) => {
    const { helper } = helperShowing({ kind: "exited", code: 0, stdout: `${state}\n` });
    expect(await helper.isRunning()).toBe(running);
  });

  it("answers isRunning true when systemctl fails, can't run or times out, as it can't tell", async () => {
    expect(await helperShowing({ kind: "exited", code: 1, stdout: "inactive\n" }).helper.isRunning()).toBe(true);
    expect(await helperShowing({ kind: "not-started" }).helper.isRunning()).toBe(true);
    expect(await helperShowing({ kind: "timed-out" }).helper.isRunning()).toBe(true);
  });
});
