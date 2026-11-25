import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The `allow-folder` drop-in (deployment.md, "systemd unit"): `ProtectSystem=strict` makes the file
 * system read-only for the service, so each local folder mapped as a resource is listed in
 * `ReadWritePaths=` there. The folder helper's shared module writes it, so `sudo not-unreachable
 * allow-folder` and the admin interface allow a folder by the same code; only running systemctl
 * from the CLI is the app's own.
 */
export {
  addFolderToDropIn,
  DEFAULT_DROP_IN_DIR,
  DROP_IN_FILE,
  dropInContent,
  foldersInDropIn,
  SERVICE_UNIT,
  systemdPath,
  UnsupportedFolderPathError,
  type DropInChange,
} from "@not-unreachable/mount-helper/folder-access";

/** The program `allow-folder` runs to reload systemd and restart the service. */
export interface SystemctlProgram {
  readonly command: string;
  readonly args?: readonly string[];
}

const execFileAsync = promisify(execFile);

/** Runs systemctl with these arguments, without a shell. */
export async function runSystemctl(program: SystemctlProgram, args: readonly string[]): Promise<void> {
  await execFileAsync(program.command, [...(program.args ?? []), ...args]);
}
