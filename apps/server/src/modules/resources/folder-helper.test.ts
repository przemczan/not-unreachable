import { describe, expect, it } from "vitest";
import { captureLogger } from "../../test-support/index.ts";
import {
  ALLOW_FOLDER_TIMEOUT_MS,
  ALLOW_FOLDER_UNIT,
  createSystemctlFolderHelper,
  type ExecFileFunction,
  type ExecResult,
} from "./index.ts";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** A fake exec answering `start` with `answer`, and `show` with the helper's status. */
function fakeExec(answer: ExecResult, helperStatus = "0\n"): { readonly exec: ExecFileFunction; readonly calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFileFunction = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs });
    if (args[0] === "show") return { kind: "exited", code: 0, stdout: helperStatus };
    return answer;
  };
  return { exec, calls };
}

const failedStart: ExecResult = { kind: "exited", code: 1, stdout: "" };

/** A helper over a fake exec, with its calls and log. */
const helperWith = (answer: ExecResult, helperStatus?: string) => {
  const fake = fakeExec(answer, helperStatus);
  const captured = captureLogger("info");
  return {
    helper: createSystemctlFolderHelper({ logger: captured.logger, systemctl: "/bin/systemctl", execFile: fake.exec }),
    calls: fake.calls,
    logs: captured.lines,
  };
};

describe("the systemctl folder helper", () => {
  it("starts exactly its unit with an argument array and a 30 s timeout", async () => {
    const { helper, calls } = helperWith({ kind: "exited", code: 0, stdout: "" });
    expect(await helper.allow()).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        file: "/bin/systemctl",
        args: ["--no-ask-password", "start", "not-unreachable-allow-folder.service"],
        timeoutMs: ALLOW_FOLDER_TIMEOUT_MS,
      },
    ]);
    expect(ALLOW_FOLDER_UNIT).toBe("not-unreachable-allow-folder.service");
    expect(ALLOW_FOLDER_TIMEOUT_MS).toBe(30_000);
  });

  it.each([
    ["20", "not-absolute"],
    ["21", "missing"],
    ["22", "not-a-folder"],
    ["23", "inside-data-directory"],
    ["24", "inside-release-directory"],
    ["25", "inside-mount-root"],
    ["26", "outside-allowed-folders"],
    ["27", "system-folder"],
    ["28", "unsupported-path"],
    ["29", "overlaps-allowed-folder"],
    ["6", "helper-unavailable"],
    ["1", "helper-failed"],
    ["2", "helper-failed"],
    ["3", "helper-failed"],
    ["4", "helper-failed"],
    ["5", "helper-failed"],
    ["7", "helper-failed"],
    ["30", "helper-failed"],
  ] as const)("maps the helper's exit code %s to %s", async (status, reason) => {
    const { helper, calls } = helperWith(failedStart, `${status}\n`);
    expect(await helper.allow()).toEqual({ ok: false, reason });
    expect(calls[1]?.args).toEqual(["show", "-p", "ExecMainStatus", "--value", ALLOW_FOLDER_UNIT]);
  });

  it("warns about a failed run with the unit and status", async () => {
    const { helper, logs } = helperWith(failedStart, "7\n");
    await helper.allow();
    expect(logs()).toContainEqual(expect.objectContaining({ level: 40, unit: ALLOW_FOLDER_UNIT, status: 7 }));
  });

  it("answers helper-unavailable when systemd never ran the helper or systemctl is missing", async () => {
    expect(await helperWith(failedStart, "0\n").helper.allow()).toEqual({ ok: false, reason: "helper-unavailable" });
    expect(await helperWith(failedStart, "\n").helper.allow()).toEqual({ ok: false, reason: "helper-unavailable" });
    expect(await helperWith({ kind: "not-started" }).helper.allow()).toEqual({ ok: false, reason: "helper-unavailable" });
  });

  it("answers helper-failed when the helper doesn't finish in time", async () => {
    const { helper, calls } = helperWith({ kind: "timed-out" });
    expect(await helper.allow()).toEqual({ ok: false, reason: "helper-failed" });
    expect(calls).toHaveLength(1);
  });
});
