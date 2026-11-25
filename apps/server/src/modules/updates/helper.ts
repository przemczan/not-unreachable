import type { UpdateReason } from "@not-unreachable/contracts";
import { MINUTE_MS, type Logger } from "../platform/index.ts";
import { execFileResult, type ExecFileFunction } from "../resources/index.ts";

/**
 * Starts the update helper's verify unit (deployment.md, "Updating from Settings"). Polkit lets the
 * service user start exactly this unit, and only while `UPDATE_FROM_UI` is on. Its start returns
 * once the release is verified and staged and the apply unit started (exit 0), or with the reason
 * it refused as its exit code, which the server reads from `ExecMainStatus`.
 */

export const VERIFY_UNIT = "not-unreachable-update.service";
/** The unit's own `TimeoutStartSec=` is 10 minutes; a little more, so systemd's ends it first. */
export const VERIFY_TIMEOUT_MS = 11 * MINUTE_MS;
const SHOW_TIMEOUT_MS = 30_000;
/** The unit's `ActiveState`s while a start of it runs: a oneshot is `activating` until it exits. */
const RUNNING_STATES: ReadonlySet<string> = new Set(["active", "activating", "deactivating", "reloading"]);

/** The verify unit's exit codes and their reasons, the update helper's `UPDATE_EXIT_REASONS` (the design's table). */
export const VERIFY_EXIT_REASONS: ReadonlyMap<number, UpdateReason> = new Map<number, UpdateReason>([
  [1, "internal"],
  [2, "internal"],
  [3, "request-invalid"],
  [4, "request-invalid"],
  [5, "request-invalid"],
  [6, "switch-off"],
  [7, "internal"],
  [8, "busy"],
  [9, "interrupted"],
  [20, "download-incomplete"],
  [21, "download-incomplete"],
  [22, "unsigned"],
  [23, "signature-invalid"],
  [24, "checksum-mismatch"],
  [25, "version-mismatch"],
  [26, "not-newer"],
  [27, "archive-unsafe"],
  [28, "archive-invalid"],
  [29, "needs-installer"],
  [30, "systemd-failed"],
  [31, "no-space"],
]);

/** How the verify unit's run ended: handed over to the apply unit, or refused with a reason. */
export type UpdateHelperOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: UpdateReason };

/** Verifies the release of the request file the server wrote, and hands it to the apply unit. */
export interface UpdateHelper {
  verify(): Promise<UpdateHelperOutcome>;
  /** Whether the verify unit is running now, such as one a stopped server started; true when systemd can't tell. */
  isRunning(): Promise<boolean>;
}

export interface SystemctlUpdateHelperDependencies {
  readonly logger: Logger;
  /** `systemctl` (found on PATH) unless given. */
  readonly systemctl?: string;
  /** `execFileResult` unless given; tests check the argument arrays and fake the answers. */
  readonly execFile?: ExecFileFunction;
}

/** The {@link UpdateHelper} of production: `systemctl --no-ask-password start not-unreachable-update.service`. */
export function createSystemctlUpdateHelper({
  logger,
  systemctl = "systemctl",
  execFile: run = execFileResult,
}: SystemctlUpdateHelperDependencies): UpdateHelper {
  /** The unit's exit code of its last run; 0 when it never ran or can't be read. */
  const helperStatus = async (): Promise<number> => {
    const shown = await run(systemctl, ["show", "-p", "ExecMainStatus", "--value", VERIFY_UNIT], SHOW_TIMEOUT_MS);
    if (shown.kind !== "exited" || shown.code !== 0) return 0;
    const status = Number.parseInt(shown.stdout.trim(), 10);
    return Number.isInteger(status) ? status : 0;
  };

  const failureOf = (status: number): UpdateHelperOutcome => {
    // No status: systemd never ran it, as polkit refused (the rule is there only while the switch is on).
    if (status === 0) {
      logger.warn({ unit: VERIFY_UNIT }, "The update helper isn't set up to install updates from Settings");
      return { ok: false, reason: "switch-off" };
    }
    const reason = VERIFY_EXIT_REASONS.get(status) ?? "internal";
    logger.warn({ unit: VERIFY_UNIT, status, reason }, "The update helper refused the update");
    return { ok: false, reason };
  };

  return {
    async verify() {
      const started = await run(systemctl, ["--no-ask-password", "start", VERIFY_UNIT], VERIFY_TIMEOUT_MS);
      if (started.kind === "not-started") {
        logger.warn({ unit: VERIFY_UNIT }, "systemctl couldn't be run");
        return { ok: false, reason: "internal" };
      }
      if (started.kind === "timed-out") {
        logger.warn({ unit: VERIFY_UNIT }, "The update helper didn't finish in time");
        return { ok: false, reason: "internal" };
      }
      if (started.code === 0) return { ok: true };
      return failureOf(await helperStatus());
    },

    async isRunning() {
      const shown = await run(systemctl, ["show", "-p", "ActiveState", "--value", VERIFY_UNIT], SHOW_TIMEOUT_MS);
      if (shown.kind !== "exited" || shown.code !== 0) return true;
      return RUNNING_STATES.has(shown.stdout.trim());
    },
  };
}
