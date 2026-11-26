#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { FolderRefusal } from "@not-unreachable/contracts";
import { parseArgs } from "node:util";
import { AdminExistsError, NoAdminError, type AccountRecord } from "./modules/accounts/index.ts";
import {
  absoluteUrl,
  backupDatabase,
  ConfigError,
  createLogger,
  DEFAULT_MASTER_KEY_FILE,
  loadConfig,
  MasterKeyError,
  prepareDatabase,
  runKeyRotation,
  systemClock,
  type Clock,
  type Config,
  type EnvelopeColumn,
  type Logger,
  type PreparedDatabase,
} from "./modules/platform/index.ts";
import {
  addFolderToDropIn,
  checkLocalFolder,
  DEFAULT_DROP_IN_DIR,
  forbiddenRootsOf,
  runSystemctl,
  SERVICE_UNIT,
  shellQuote,
  UnsupportedFolderPathError,
  type SystemctlProgram,
} from "./modules/resources/index.ts";
import { createSettingsService } from "./modules/settings/index.ts";
import { openSignInGate } from "./modules/sign-in/index.ts";
import { createServices, type AppServices } from "./services.ts";

interface Output {
  write(text: string): unknown;
}

/** Where the CLI reads the operator's answers; `isTTY` tells whether someone can type them. */
export interface Input extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface CliIo {
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: Output;
  readonly stderr: Output;
  /** `process.stdin` when left out. */
  readonly stdin?: Input;
  readonly clock?: Clock;
  /** Tests only: another migrations folder. */
  readonly migrationsFolder?: string;
  /** Tests only: another envelope-column registry for `rotate-key`. */
  readonly envelopeColumns?: readonly EnvelopeColumn[];
  /** Tests only: whether the CLI runs as root (`allow-folder`); the process's uid tells when left out. */
  readonly isRoot?: boolean;
  /** Tests only: where `allow-folder` writes its drop-in and the systemctl it runs. */
  readonly systemd?: { readonly dropInDir?: string; readonly systemctl?: SystemctlProgram };
  /** Tests only: the runuser `allow-folder` checks the service user's access with, given as systemctl is. */
  readonly runuser?: SystemctlProgram;
}

const USAGE = `Usage: not-unreachable <command> [options]

Commands:
  migrate                     Apply pending database migrations (after a pre-migration backup).
  backup                      Back the database up into backups/ and keep the last 7.
  rotate-key [--key-file F]   Re-encrypt every secret under a new master key
                              (default ${DEFAULT_MASTER_KEY_FILE}; run as root, service stopped).
  setup-link                  Print a one-time link (valid 1 hour) to create the first admin;
                              replaces any earlier link. Refused once an admin exists.
  reset-admin [--password] [--second-factors] [--yes]
                              Recover a lost admin account and sign the admin out everywhere.
                              --password (the default) removes the admin's password and prints a
                              one-time link (valid 1 hour) to set a new one; --second-factors
                              removes the authenticator apps and recovery codes, so the next
                              sign-in enrols a new app. Asks you to type the admin's username
                              unless --yes.
  allow-folder <path>         Let the service write to a local folder (run as root): add it to the
                              systemd drop-in ${DEFAULT_DROP_IN_DIR}/resources.conf,
                              then reload systemd, restart the service and check that the
                              service's user may read, write and enter the folder.
`;

interface Context {
  readonly io: CliIo;
  readonly config: Config;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly args: readonly string[];
}

/** Runs one CLI command and answers its exit code (0 ok, 1 failure, 2 usage). */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    (command === undefined ? io.stderr : io.stdout).write(USAGE);
    return command === undefined ? 2 : 0;
  }
  const run = commands[command];
  if (run === undefined) {
    io.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  try {
    const config = loadConfig(io.environment);
    const logger = createLogger(config, { write: (line: string) => io.stderr.write(line) });
    return await run({ io, config, clock: io.clock ?? systemClock, logger, args });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MasterKeyError || error instanceof UsageError) {
      io.stderr.write(`${command}: ${error.message}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
    io.stderr.write(`${command} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

const commands: Partial<Record<string, (context: Context) => number | Promise<number>>> = {
  migrate(context) {
    noArguments(context);
    const prepared = prepare(context);
    try {
      const { applied, backupFile } = prepared.migration;
      if (applied.length === 0) {
        context.io.stdout.write("The database is up to date; no migrations applied.\n");
      } else {
        context.io.stdout.write(`Backed up the database to ${String(backupFile)}\n`);
        context.io.stdout.write(`Applied ${applied.length} migration(s):\n${applied.map((m) => `  ${m.tag}\n`).join("")}`);
      }
      return 0;
    } finally {
      prepared.database.sqlite.close();
    }
  },

  backup(context) {
    noArguments(context);
    const prepared = prepare(context);
    try {
      const result = backupDatabase(prepared.database, prepared.paths.backupsDir, context.clock);
      context.io.stdout.write(`Backed up the database to ${result.file}\n`);
      if (result.removed.length > 0) {
        context.io.stdout.write(`Removed ${result.removed.length} older backup(s), keeping the last 7.\n`);
      }
      return 0;
    } finally {
      prepared.database.sqlite.close();
    }
  },

  "setup-link"(context) {
    noArguments(context);
    return withServices(context, (services) => {
      try {
        const issued = services.setup.issueFirstRunToken();
        context.io.stdout.write(
          [
            "Open this link to create the admin account (valid 1 hour, once; running setup-link again replaces it):",
            `  ${setupLink(context.config, issued.token)}`,
            "",
          ].join("\n"),
        );
        return 0;
      } catch (error) {
        if (error instanceof AdminExistsError) {
          context.io.stderr.write(`setup-link: ${error.message}\n`);
          return 1;
        }
        throw error;
      }
    });
  },

  "reset-admin"(context) {
    const { values } = parseCommandArgs(context, {
      yes: { type: "boolean" },
      password: { type: "boolean" },
      "second-factors": { type: "boolean" },
    });
    const steps = resetSteps({ password: values.password === true, secondFactors: values["second-factors"] === true });
    return withServices(context, async (services) => {
      const admin = services.accounts.findAdmin();
      if (admin === undefined) {
        context.io.stderr.write(`reset-admin: ${new NoAdminError().message}\n`);
        return 1;
      }
      if (values.yes !== true && !(await confirmReset(context, admin, steps))) return 1;

      const removedSignInMethods = steps.filter((step) => step.remove(services, admin)).map((step) => step.method);
      const revokedSessions = services.sessions.revokeAll(admin.id, "admin-reset", { actor: { kind: "system" } });
      services.audit.record({
        action: "admin.reset",
        actor: { kind: "system" },
        outcome: "succeeded",
        target: { kind: "account", id: admin.id },
        details: { revokedSessions, removedSignInMethods },
      });
      const removed = removedSignInMethods.length === 0 ? "nothing" : removedSignInMethods.join(", ");
      const lines = [`Reset the admin account "${admin.username}": removed ${removed}; signed out ${revokedSessions} session(s).`];
      if (steps.some((step) => step.method === "password")) {
        const issued = services.setup.issueAdminResetToken();
        lines.push("Open this link to set the admin's new password (valid 1 hour, once):", `  ${setupLink(context.config, issued.token)}`);
      }
      if (steps.some((step) => step.method === "second-factors")) {
        lines.push("The admin's next sign-in asks to set up an authenticator app.");
      }
      context.io.stdout.write([...lines, ""].join("\n"));
      return 0;
    });
  },

  async "allow-folder"(context) {
    const path = onePositional(context, "allow-folder <path>");
    if (!runsAsRoot(context.io)) {
      context.io.stderr.write("allow-folder: run it as root, such as with sudo. Nothing changed.\n");
      return 1;
    }
    try {
      return await allowFolder(context, path);
    } catch (error) {
      if (!(error instanceof UnsupportedFolderPathError)) throw error;
      context.io.stderr.write(`allow-folder: ${error.message}. Nothing changed.\n`);
      return 1;
    }
  },

  "rotate-key"(context) {
    const { values } = parseCommandArgs(context, { "key-file": { type: "string" } });
    const keyFile = values["key-file"] ?? DEFAULT_MASTER_KEY_FILE;
    const prepared = prepare(context);
    try {
      const result = runKeyRotation({
        database: prepared.database,
        backupsDir: prepared.paths.backupsDir,
        clock: context.clock,
        keyFile,
        ...(context.io.envelopeColumns === undefined ? {} : { columns: context.io.envelopeColumns }),
      });
      const total = result.columns.reduce((sum, column) => sum + column.reencrypted, 0);
      context.io.stdout.write(
        [
          `Backed up the database to ${result.backupFile}`,
          `Re-encrypted ${total} secret(s) from key ${result.oldKeyId} to key ${result.newKeyId}.`,
          `The new master key is in ${result.keyFile}; the old one is in ${result.previousKeyFile}.`,
          "",
          "Next steps:",
          `  1. Store a copy of ${result.keyFile} somewhere apart from the database backups.`,
          "     Without it, encrypted secrets in the database can't be recovered.",
          "  2. Start the service again.",
          `  3. Once it runs, delete ${result.previousKeyFile} (backups made before the rotation still need the old key).`,
          "",
        ].join("\n"),
      );
      return 0;
    } finally {
      prepared.database.sqlite.close();
    }
  },
};

/** Why `allow-folder` refuses a folder, as the operator reads it. */
const folderRefusalMessages: Record<FolderRefusal, string> = {
  "not-absolute": "the path must be absolute (start with /).",
  missing: "no folder exists at that path.",
  "not-a-folder": "that path is not a folder.",
  "not-writable": "even root can't write to that folder (is it on a read-only file system?).",
  "inside-data-directory": "the folder overlaps the service's data directory.",
  "inside-release-directory": "the folder overlaps the service's release directory.",
  "inside-mount-root": "the folder overlaps the folder SMB shares are mounted in.",
};

/** `allow-folder` must change system files: only root may. */
function runsAsRoot(io: CliIo): boolean {
  return io.isRoot ?? process.getuid?.() === 0;
}

async function allowFolder(context: Context, path: string): Promise<number> {
  const { io } = context;
  const checked = await checkLocalFolder(path, { forbiddenRoots: forbiddenRootsOf({ dataDir: context.config.dataDir }) });
  if (!checked.ok) {
    io.stderr.write(`allow-folder: ${folderRefusalMessages[checked.reason]} Nothing changed.\n`);
    return 1;
  }
  const dropIn = await addFolderToDropIn(io.systemd?.dropInDir ?? DEFAULT_DROP_IN_DIR, checked.realPath);
  io.stdout.write(
    dropIn.changed
      ? `Added ${checked.realPath} to ${dropIn.file}.\n`
      : `${checked.realPath} is already in ${dropIn.file}; nothing to add.\n`,
  );
  const systemctl = io.systemd?.systemctl ?? { command: "systemctl" };
  await runSystemctl(systemctl, ["daemon-reload"]);
  await runSystemctl(systemctl, ["restart", SERVICE_UNIT]);
  const access = await checkServiceUserAccess(io.runuser ?? { command: "runuser" }, checked.realPath);
  const canWrite = access.checked && access.missing.length === 0;
  io.stdout.write(
    `Reloaded systemd and restarted ${SERVICE_UNIT}: ` +
      (canWrite
        ? `the service can now write to ${checked.realPath}.\n`
        : `its sandbox no longer keeps the service from writing to ${checked.realPath}.\n`),
  );
  if (!access.checked) io.stderr.write(uncheckedAccessWarning(checked.realPath, access.reason));
  else if (!canWrite) io.stderr.write(missingAccessWarning(checked.realPath, access.missing));
  return 0;
}

/** The service's own user, as the CLI wrapper and the installer name it (`SERVICE_USER`). */
const SERVICE_USER = "not-unreachable";

/** What the service needs on an allowed folder: `test`'s flag for it and its name in a warning. */
const folderAccess = [
  { flag: "-r", name: "read (r)" },
  { flag: "-w", name: "write (w)" },
  { flag: "-x", name: "enter (x)" },
] as const;

/** Whether the service user may use a folder: what it lacks, or why that couldn't be checked. */
type ServiceUserAccess =
  { readonly checked: true; readonly missing: readonly string[] } | { readonly checked: false; readonly reason: string };

/**
 * Lifting the sandbox is not enough: the service user needs Unix permission on the folder too.
 * A probe that runs `true` first tells a missing runuser or user apart from `test` answering no,
 * since both runuser's failures and a false `test` exit 1.
 */
async function checkServiceUserAccess(runuser: SystemctlProgram, path: string): Promise<ServiceUserAccess> {
  const probe = await runAsServiceUser(runuser, ["true"]);
  if (!("exitCode" in probe) || probe.exitCode !== 0) return { checked: false, reason: runFailure(probe, "runuser") };
  const missing: string[] = [];
  for (const access of folderAccess) {
    const result = await runAsServiceUser(runuser, ["test", access.flag, path]);
    if ("exitCode" in result && result.exitCode === 0) continue;
    if ("exitCode" in result && result.exitCode === 1) missing.push(access.name);
    else return { checked: false, reason: runFailure(result, `test ${access.flag}`) };
  }
  return { checked: true, missing };
}

/** How a run as the service user ended: its exit code, or why it didn't run to one. */
type RunOutcome = { readonly exitCode: number; readonly stderr: string } | { readonly failure: string };

const RUNUSER_TIMEOUT_MS = 10_000;

/**
 * Runs a command as the service user, without a shell. runuser sets up its supplementary groups, so
 * group and ACL access count as they do for the service; `spawn` with a `uid` would drop them and
 * warn wrongly.
 */
function runAsServiceUser(runuser: SystemctlProgram, command: readonly string[]): Promise<RunOutcome> {
  const args = [...(runuser.args ?? []), "-u", SERVICE_USER, "--", ...command];
  return new Promise((resolve) => {
    execFile(runuser.command, args, { timeout: RUNUSER_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) resolve({ exitCode: 0, stderr });
      else if (typeof error.code === "number") resolve({ exitCode: error.code, stderr });
      else resolve({ failure: error.message });
    });
  });
}

function runFailure(outcome: RunOutcome, what: string): string {
  if ("failure" in outcome) return outcome.failure;
  const firstLine = outcome.stderr.trim().split("\n")[0] ?? "";
  return firstLine === "" ? `${what} exited with ${outcome.exitCode}` : firstLine;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

function missingAccessWarning(path: string, missing: readonly string[]): string {
  const quoted = shellQuote(path);
  return [
    `allow-folder: warning: the service's user ${SERVICE_USER} lacks ${listed(missing)} permission on ${path},`,
    "so the service still can't write to it. Give the user access, such as with an ACL:",
    `  sudo setfacl -m u:${SERVICE_USER}:rwx ${quoted}`,
    `or by making ${SERVICE_USER} the folder's owner (or giving its group rwx and adding ${SERVICE_USER} to it):`,
    `  sudo chown ${SERVICE_USER} ${quoted}`,
    `Every folder above it needs enter (x) permission for ${SERVICE_USER} too. Then run allow-folder again to check.`,
    "",
  ].join("\n");
}

function uncheckedAccessWarning(path: string, reason: string): string {
  const quoted = shellQuote(path);
  return [
    `allow-folder: warning: couldn't check whether the service's user ${SERVICE_USER} may use ${path} (${reason}).`,
    "Check it by hand; this prints ok when it may read, write and enter the folder:",
    `  sudo runuser -u ${SERVICE_USER} -- test -r ${quoted} -a -w ${quoted} -a -x ${quoted} && echo ok`,
    "",
  ].join("\n");
}

function prepare(context: Context): PreparedDatabase {
  return prepareDatabase(context.config, {
    clock: context.clock,
    logger: context.logger,
    ...(context.io.migrationsFolder === undefined ? {} : { migrationsFolder: context.io.migrationsFolder }),
  });
}

/** The link a setup token goes in: in the fragment, so it never reaches the proxy's logs. */
function setupLink(config: Config, token: string): string {
  return `${absoluteUrl(config, "/setup")}#${token}`;
}

/** Runs `work` with the app's services over the migrated database, then closes it. */
async function withServices(context: Context, work: (services: AppServices) => number | Promise<number>): Promise<number> {
  const prepared = prepare(context);
  try {
    const { db } = prepared.database;
    const settings = createSettingsService({ db, clock: context.clock, logger: context.logger });
    // The CLI proves no password, so it needs no sign-in limits, nor the master key they hash with.
    return await work(
      createServices({
        db,
        clock: context.clock,
        logger: context.logger,
        settings,
        resourceRoots: { dataDir: context.config.dataDir },
        publicOrigin: context.config.publicOrigin,
        signInGate: () => openSignInGate,
      }),
    );
  } finally {
    prepared.database.sqlite.close();
  }
}

/** One thing `reset-admin` removes from the admin account; `remove` answers whether there was one. */
interface ResetStep {
  /** As `admin.reset` records it in `removedSignInMethods`. */
  readonly method: "password" | "second-factors";
  /** What it removes, as the confirmation names it. */
  readonly description: string;
  remove(services: AppServices, admin: AccountRecord): boolean;
}

const passwordStep: ResetStep = {
  method: "password",
  description: "the password",
  remove: (services, admin) => services.accounts.deletePassword(admin.id),
};

/** Records `second-factor.removed` as the system for each (threat model, T10). */
const secondFactorsStep: ResetStep = {
  method: "second-factors",
  description: "the authenticator apps, passkeys and recovery codes",
  remove: (services, admin) => {
    const removed = services.secondFactors.removeAll(admin.id);
    return removed.totp + removed.passkeys + removed.recoveryCodes > 0;
  },
};

/** What `reset-admin` removes, in order: the password unless only `--second-factors` is given. */
function resetSteps(options: { readonly password: boolean; readonly secondFactors: boolean }): ResetStep[] {
  if (!options.secondFactors) return [passwordStep];
  return options.password ? [passwordStep, secondFactorsStep] : [secondFactorsStep];
}

/** Asks the operator to type the admin's username; refuses without a terminal or on another name. */
async function confirmReset(context: Context, admin: AccountRecord, steps: readonly ResetStep[]): Promise<boolean> {
  const stdin = context.io.stdin ?? process.stdin;
  if (stdin.isTTY !== true) {
    context.io.stderr.write("reset-admin: no terminal to confirm on; run it in a terminal or pass --yes. Nothing changed.\n");
    return false;
  }
  const removes = steps.map((step) => step.description).join(" and ");
  context.io.stderr.write(
    `This removes ${removes} of the admin account "${admin.username}" and signs it out everywhere.\n` +
      "Type the admin's username to confirm: ",
  );
  const typed = (await readLine(stdin))?.trim().toLowerCase();
  if (typed !== admin.username) {
    context.io.stderr.write("reset-admin: that is not the admin's username. Nothing changed.\n");
    return false;
  }
  return true;
}

async function readLine(input: Input): Promise<string | undefined> {
  const lines = createInterface({ input, terminal: false });
  try {
    for await (const line of lines) return line;
    return undefined;
  } finally {
    lines.close();
  }
}

type CommandOptions = Record<string, { type: "string" } | { type: "boolean" }>;

function parseCommandArgs<T extends CommandOptions>(context: Context, options: T) {
  try {
    return parseArgs({ args: [...context.args], options, strict: true, allowPositionals: false });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** The one positional argument a command takes. */
function onePositional(context: Context, usage: string): string {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args: [...context.args], options: {}, strict: true, allowPositionals: true }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [value] = positionals;
  if (value === undefined || positionals.length !== 1) throw new UsageError(`usage: not-unreachable ${usage}`);
  return value;
}

function noArguments(context: Context): void {
  parseCommandArgs(context, {});
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
