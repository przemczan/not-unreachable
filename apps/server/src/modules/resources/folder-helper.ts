import type { AllowFolderRefusal } from "@not-unreachable/contracts";
import type { Logger } from "../platform/index.ts";
import { execFileResult, MOUNT_TIMEOUT_MS, type ExecFileFunction } from "./mount-runner.ts";

/**
 * Starts the root folder helper's unit (deployment.md, "Allowing folders from the admin
 * interface"). The service never writes the drop-in itself: polkit lets it start exactly this unit,
 * and only while `ALLOW_FOLDERS_FROM_UI` is on. The helper reads the request file the app wrote,
 * checks the folder again as root, rewrites the drop-in, reloads systemd and restarts the service
 * 3 seconds later, so its start returns before the service stops.
 */

export const ALLOW_FOLDER_UNIT = "not-unreachable-allow-folder.service";
/** The helper only checks a folder and rewrites one file; the mount helper's timeout is plenty. */
export const ALLOW_FOLDER_TIMEOUT_MS = MOUNT_TIMEOUT_MS;

/**
 * How the helper's run ended: allowed, the folder refused by its rules, or `helper-unavailable`
 * (polkit refused, the unit isn't installed or the switch is off in its config) or `helper-failed`.
 */
export type FolderHelperOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: AllowFolderRefusal | "helper-unavailable" | "helper-failed" };

/** Allows the folder of the request file the app wrote. */
export interface FolderHelper {
  allow(): Promise<FolderHelperOutcome>;
}

/** The helper's exit codes for a refused folder, one per rule. */
const HELPER_REFUSALS: ReadonlyMap<number, AllowFolderRefusal> = new Map([
  [20, "not-absolute"],
  [21, "missing"],
  [22, "not-a-folder"],
  [23, "inside-data-directory"],
  [24, "inside-release-directory"],
  [25, "inside-mount-root"],
  [26, "outside-allowed-folders"],
  [27, "system-folder"],
  [28, "unsupported-path"],
  [29, "overlaps-allowed-folder"],
]);
/** `ALLOW_FOLDERS_FROM_UI` is off in `config.env` as the helper reads it. */
const SWITCH_OFF = 6;

export interface SystemctlFolderHelperDependencies {
  readonly logger: Logger;
  /** `systemctl` (found on PATH) unless given. */
  readonly systemctl?: string;
  /** {@link execFileResult} unless given; tests check the argument arrays and fake the answers. */
  readonly execFile?: ExecFileFunction;
}

/** The {@link FolderHelper} of production: `systemctl start not-unreachable-allow-folder.service`. */
export function createSystemctlFolderHelper({
  logger,
  systemctl = "systemctl",
  execFile: run = execFileResult,
}: SystemctlFolderHelperDependencies): FolderHelper {
  /** The helper's exit code of its last run; 0 when it never ran or can't be read. */
  const helperStatus = async (): Promise<number> => {
    const shown = await run(systemctl, ["show", "-p", "ExecMainStatus", "--value", ALLOW_FOLDER_UNIT], ALLOW_FOLDER_TIMEOUT_MS);
    if (shown.kind !== "exited" || shown.code !== 0) return 0;
    const status = Number.parseInt(shown.stdout.trim(), 10);
    return Number.isInteger(status) ? status : 0;
  };

  const failureOf = (status: number): FolderHelperOutcome => {
    // No helper status: systemd never ran it (polkit denied, unit not installed).
    if (status === 0 || status === SWITCH_OFF) {
      logger.warn({ unit: ALLOW_FOLDER_UNIT, status }, "The folder helper isn't set up to allow folders from the admin interface");
      return { ok: false, reason: "helper-unavailable" };
    }
    const refusal = HELPER_REFUSALS.get(status);
    if (refusal !== undefined) return { ok: false, reason: refusal };
    logger.warn({ unit: ALLOW_FOLDER_UNIT, status }, "The folder helper failed");
    return { ok: false, reason: "helper-failed" };
  };

  return {
    async allow() {
      const started = await run(systemctl, ["--no-ask-password", "start", ALLOW_FOLDER_UNIT], ALLOW_FOLDER_TIMEOUT_MS);
      if (started.kind === "not-started") {
        logger.warn({ unit: ALLOW_FOLDER_UNIT }, "systemctl couldn't be run");
        return { ok: false, reason: "helper-unavailable" };
      }
      if (started.kind === "timed-out") {
        logger.warn({ unit: ALLOW_FOLDER_UNIT }, "The folder helper didn't finish within 30 seconds");
        return { ok: false, reason: "helper-failed" };
      }
      if (started.code === 0) return { ok: true };
      return failureOf(await helperStatus());
    },
  };
}
