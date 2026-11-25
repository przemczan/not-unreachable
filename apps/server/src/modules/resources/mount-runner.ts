import { execFile } from "node:child_process";
import type { ShareFailure } from "@not-unreachable/contracts";
import type { Logger } from "../platform/index.ts";

/**
 * Starts and stops the root mount helper's template unit (smb.md, "What happens underneath"). The
 * service never mounts anything itself: polkit lets it start and stop exactly these units.
 */

export const MOUNT_UNIT_PREFIX = "not-unreachable-mount@";
/** The helper's own `TimeoutStartSec=` is the same, so a hung server ends the start either way. */
export const MOUNT_TIMEOUT_MS = 30_000;

const MOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MountOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: ShareFailure };

/** Mounts and unmounts a share by its resource id (or Test connection's temporary one). */
export interface MountRunner {
  /** Mounts the share whose request file the app wrote for `id`. */
  start(id: string): Promise<MountOutcome>;
  stop(id: string): Promise<MountOutcome>;
  isActive(id: string): Promise<boolean>;
}

/** How a program run ended: its exit code and output, the timeout, or never started (no such program). */
export type ExecResult =
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "not-started" };

/** Runs a program with an argument array, never through a shell; never throws. */
export type ExecFileFunction = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/** A lower-case UUID, the only instance name the polkit rule allows and the helper checks again. */
export function assertMountId(id: string): void {
  // Our ids are always UUIDs; anything else is a bug that must not reach a path or a unit name.
  if (!MOUNT_ID.test(id)) throw new Error("A mount id must be a lower-case UUID");
}

export function mountUnit(id: string): string {
  assertMountId(id);
  return `${MOUNT_UNIT_PREFIX}${id}.service`;
}

/** `child_process.execFile`, answering how the program ended instead of throwing. */
export const execFileResult: ExecFileFunction = async (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, killSignal: "SIGTERM" }, (error, stdout) => {
      if (error === null) return resolve({ kind: "exited", code: 0, stdout });
      if (error.killed === true) return resolve({ kind: "timed-out" });
      // A number is the exit code; a string such as ENOENT means it never started.
      resolve(typeof error.code === "number" ? { kind: "exited", code: error.code, stdout } : { kind: "not-started" });
    });
  });

/** The helper's exit codes the admin can act on; every other one is `mount-failed`. */
const HELPER_FAILURES: ReadonlyMap<number, ShareFailure> = new Map([
  [10, "auth"],
  [11, "unreachable"],
  [12, "no-share"],
  [13, "not-supported"],
]);
/** Usage, request missing, refused or invalid: the app wrote something the helper wouldn't take. */
const REQUEST_ERRORS = new Set([2, 3, 4, 5]);

export interface SystemctlMountRunnerDependencies {
  readonly logger: Logger;
  /** `systemctl` (found on PATH) unless given. */
  readonly systemctl?: string;
  /** {@link execFileResult} unless given; tests check the argument arrays and fake the answers. */
  readonly execFile?: ExecFileFunction;
}

/** The {@link MountRunner} of production: `systemctl start|stop not-unreachable-mount@<id>.service`. */
export function createSystemctlMountRunner({
  logger,
  systemctl = "systemctl",
  execFile: run = execFileResult,
}: SystemctlMountRunnerDependencies): MountRunner {
  const control = async (verb: "start" | "stop", unit: string): Promise<ExecResult> =>
    run(systemctl, ["--no-ask-password", verb, unit], MOUNT_TIMEOUT_MS);

  /** The helper's exit code of its last run; 0 when it never ran or can't be read. */
  const helperStatus = async (unit: string): Promise<number> => {
    const shown = await run(systemctl, ["show", "-p", "ExecMainStatus", "--value", unit], MOUNT_TIMEOUT_MS);
    if (shown.kind !== "exited" || shown.code !== 0) return 0;
    const status = Number.parseInt(shown.stdout.trim(), 10);
    return Number.isInteger(status) ? status : 0;
  };

  const failureOf = (unit: string, status: number): ShareFailure => {
    // No helper status: systemd never ran it (polkit denied, unit not installed).
    if (status === 0) {
      logger.warn({ unit }, "systemctl couldn't start the mount helper's unit");
      return "helper-unavailable";
    }
    if (REQUEST_ERRORS.has(status)) logger.warn({ unit, status }, "The mount helper refused the app's request");
    return HELPER_FAILURES.get(status) ?? "mount-failed";
  };

  return {
    async start(id) {
      const unit = mountUnit(id);
      const started = await control("start", unit);
      if (started.kind === "not-started") return { ok: false, reason: "helper-unavailable" };
      if (started.kind === "timed-out") {
        logger.warn({ unit }, "The share didn't mount within 30 seconds");
        // So the unit doesn't stay half-started and mount later behind the app's back.
        await control("stop", unit);
        return { ok: false, reason: "unreachable" };
      }
      if (started.code === 0) return { ok: true };
      return { ok: false, reason: failureOf(unit, await helperStatus(unit)) };
    },

    async stop(id) {
      const unit = mountUnit(id);
      const stopped = await control("stop", unit);
      if (stopped.kind === "exited" && stopped.code === 0) return { ok: true };
      if (stopped.kind === "not-started") return { ok: false, reason: "helper-unavailable" };
      return { ok: false, reason: stopped.kind === "timed-out" ? "unreachable" : "mount-failed" };
    },

    async isActive(id) {
      const answered = await run(systemctl, ["is-active", mountUnit(id)], MOUNT_TIMEOUT_MS);
      return answered.kind === "exited" && answered.code === 0;
    },
  };
}
