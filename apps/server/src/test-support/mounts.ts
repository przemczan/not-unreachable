import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShareFailure } from "@not-unreachable/contracts";
import type { MountOutcome, MountRunner } from "../modules/resources/index.ts";

/** A request file as the fake helper found it when its unit started. */
export interface ReceivedMountRequest {
  readonly id: string;
  /** The file's permission bits, such as 0o600. */
  readonly mode: number;
  readonly request: unknown;
}

/** A {@link MountRunner} that needs no root: a "mount" is a folder made at `<mountRoot>/<id>`. */
export interface FakeMountRunner extends MountRunner {
  /** Every call in order, such as `start <id>`, `stop <id>`, `is-active <id>`. */
  readonly calls: string[];
  readonly requests: ReceivedMountRequest[];
  /** The units started and not stopped since. */
  readonly active: Set<string>;
  /** Every start fails with this reason until it is set back to undefined. */
  failWith: ShareFailure | undefined;
  /** Only the next start fails with this reason. */
  failNextStart: ShareFailure | undefined;
  /** Every stop fails with this reason until it is set back to undefined. */
  failStopWith: ShareFailure | undefined;
  /** Runs on every successful start with the mount point, to put files "on the share". */
  onMount: ((mountPoint: string) => void) | undefined;
}

export interface FakeMountRunnerOptions {
  readonly mountRoot: string;
  readonly requestsDir: string;
}

/** A fake of the mount helper behind systemctl: reads and deletes the request file, as the helper does. */
export function fakeMountRunner({ mountRoot, requestsDir }: FakeMountRunnerOptions): FakeMountRunner {
  const runner: FakeMountRunner = {
    calls: [],
    requests: [],
    active: new Set(),
    failWith: undefined,
    failNextStart: undefined,
    failStopWith: undefined,
    onMount: undefined,

    async start(id): Promise<MountOutcome> {
      runner.calls.push(`start ${id}`);
      const file = join(requestsDir, `${id}.json`);
      try {
        runner.requests.push({ id, mode: statSync(file).mode & 0o777, request: JSON.parse(readFileSync(file, "utf8")) });
        unlinkSync(file);
      } catch {
        // No request file: the helper exits 3 (request missing).
        return { ok: false, reason: "mount-failed" };
      }
      const failure = runner.failNextStart ?? runner.failWith;
      runner.failNextStart = undefined;
      if (failure !== undefined) return { ok: false, reason: failure };
      const mountPoint = join(mountRoot, id);
      mkdirSync(mountPoint, { recursive: true });
      runner.active.add(id);
      runner.onMount?.(mountPoint);
      return { ok: true };
    },

    async stop(id): Promise<MountOutcome> {
      runner.calls.push(`stop ${id}`);
      if (runner.failStopWith !== undefined) return { ok: false, reason: runner.failStopWith };
      // The helper's unmount removes the mount point, so test mounts leave nothing behind.
      if (runner.active.delete(id)) rmSync(join(mountRoot, id), { recursive: true, force: true });
      return { ok: true };
    },

    async isActive(id) {
      runner.calls.push(`is-active ${id}`);
      return runner.active.has(id);
    },
  };
  return runner;
}

/** A path as mountinfo writes it: a backslash and a space escaped in octal. */
function escapeMountPath(path: string): string {
  return path.replaceAll("\\", String.raw`\134`).replaceAll(" ", String.raw`\040`);
}

/** Writes a mountinfo file in which each of `cifsMounts` is a `cifs` mount, after a root line. */
export function writeMountInfo(file: string, cifsMounts: readonly string[]): void {
  const lines = [
    "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
    ...cifsMounts.map(
      (path, index) =>
        `${String(100 + index)} 22 0:${String(50 + index)} / ${escapeMountPath(path)} rw,nosuid,nodev,noexec - cifs //nas/share rw,vers=3.1.1`,
    ),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
}
