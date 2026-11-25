import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the helper is one file, not a module with an index.ts.
import { KILL_GRACE, runProgram } from "../src/update-helper.mts";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "run-program-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bash = (script: string, timeout: number): ReturnType<typeof runProgram> =>
  runProgram("/bin/bash", ["-c", script], { timeout, cwd: root });

/**
 * Whether the process runs. A killed one may stay a zombie where nothing reaps orphans (a container
 * whose PID 1 isn't an init), which `kill(pid, 0)` still finds, so its state is read too.
 */
async function alive(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (stat === undefined) return false;
  // The state follows the command name, which is in parentheses and may hold spaces.
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

/** The pid a script wrote to `pids`, once it has. */
async function readPid(name: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(join(root, name), "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${name} was not written`);
}

/** A killed process is gone, or a zombie, once its signal has landed, which may take a moment. */
async function expectGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && (await alive(pid)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await alive(pid)).toBe(false);
}

describe("runProgram", () => {
  it("resolves the exit code and the captured output", async () => {
    expect(await bash("echo out; exit 3", 10_000)).toEqual({ code: 3, stdout: "out\n" });
  });

  it("resolves null for a program that exceeds its time", async () => {
    const started = Date.now();
    expect(await bash("sleep 30", 200)).toEqual({ code: null, stdout: "" });
    expect(Date.now() - started).toBeLessThan(KILL_GRACE);
  });

  it("resolves null for a program that exits 0 after SIGTERM", async () => {
    const result = await bash('trap "exit 0" TERM; sleep 30 & wait', 200);
    expect(result.code).toBeNull();
  });

  it("ends a program that ignores SIGTERM with SIGKILL after the grace", async () => {
    const started = Date.now();
    const result = await bash(`trap "" TERM; echo $$ > ${join(root, "leader")}; sleep 30`, 200);
    const elapsed = Date.now() - started;
    expect(result.code).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE - 100);
    expect(elapsed).toBeLessThan(KILL_GRACE + 4000);
    await expectGone(await readPid("leader"));
  }, 15_000);

  it("kills what the program started too", async () => {
    // The grandchild ignores SIGTERM and has no hold on the output, so the leader's end is what
    // closes the run, and the grandchild is killed then, without the grace.
    const script = `(trap "" TERM; exec sleep 30) > /dev/null & echo $! > ${join(root, "pid")}; wait`;
    const started = Date.now();
    const result = await bash(script, 300);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(KILL_GRACE);
    await expectGone(await readPid("pid"));
  });

  it("kills a grandchild that holds the output open once the grace is over", async () => {
    const script = `(trap "" TERM; exec sleep 30) & echo $! > ${join(root, "pid")}; wait`;
    const result = await bash(script, 300);
    expect(result.code).toBeNull();
    await expectGone(await readPid("pid"));
  }, 15_000);
});
