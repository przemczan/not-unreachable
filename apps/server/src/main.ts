import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { DestinationStream } from "pino";
import { buildApp } from "./app.ts";
import { scheduleAuditRetention, type AuditService } from "./modules/audit/index.ts";
import { scheduleUploadsCleanup } from "./modules/files/index.ts";
import { scheduleShareLinkUnlocksPurge } from "./modules/share-links/index.ts";
import {
  checkWebRoot,
  createJobScheduler,
  createLogger,
  createSecrets,
  loadConfig,
  loadMasterKey,
  notifyReady,
  prepareDatabase,
  serverVersion,
  systemClock,
  systemTimers,
  type Clock,
  type Database,
  type JobScheduler,
  type Logger,
  type MigrationResult,
} from "./modules/platform/index.ts";
import { allowFromUiOf, scheduleResourceRetries } from "./modules/resources/index.ts";
import { scheduleSecondFactorsSweep } from "./modules/second-factors/index.ts";
import { createSettingsService } from "./modules/settings/index.ts";
import { createSignInLimits, scheduleSignInLimitsSweep } from "./modules/sign-in/index.ts";
import { scheduleSsoFlowsPurge } from "./modules/sso/index.ts";
import { scheduleUpdateChecks } from "./modules/updates/index.ts";
import { handleProcessErrors } from "./process-errors.ts";
import { createServices } from "./services.ts";

/** `dist/web/`, next to `dist/main.js`, where the build copies the SPA. */
export const defaultWebRoot = fileURLToPath(new URL("./web/", import.meta.url));

export interface StartOptions {
  readonly clock?: Clock;
  /** Where log lines go; stdout (journald) by default. */
  readonly logDestination?: DestinationStream;
  /** Tests only: another migrations folder. */
  readonly migrationsFolder?: string;
  /** The built SPA; `null` serves none (tests only). */
  readonly webRoot?: string | null;
  /** Tests only: the program that tells systemd the service is ready. */
  readonly notify?: { readonly command: string; readonly args: readonly string[] };
}

export interface ServerHandle {
  readonly app: FastifyInstance;
  readonly port: number;
  /** Stops accepting requests, lets running ones finish, then closes the database. */
  close(): Promise<void>;
}

/** Thrown by {@link startServer} after it logged why it couldn't start and closed what it had opened. */
export class StartupError extends Error {
  override readonly name = "StartupError";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Listens on the app's server instead of `app.listen`: for the wildcard `0.0.0.0` Fastify logs every
 * interface's address through `os.networkInterfaces()`, which needs AF_NETLINK, and the systemd unit's
 * RestrictAddressFamilies doesn't allow it (the call throws EAFNOSUPPORT).
 */
async function listen(app: FastifyInstance, host: string, port: number): Promise<void> {
  await app.ready();
  // Rejects on the server's "error" event, such as EADDRINUSE.
  const listening = once(app.server, "listening");
  app.server.listen({ host, port });
  await listening;
  const address = app.server.address();
  if (typeof address === "object" && address !== null) {
    const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
    app.log.info(`Server listening at http://${shownHost}:${address.port}`);
  }
}

function recordStart(audit: AuditService, migration: MigrationResult): void {
  if (migration.applied.length > 0) {
    audit.record({
      action: "system.migrated",
      actor: { kind: "system" },
      outcome: "succeeded",
      details: { migrations: migration.applied.map((entry) => entry.tag) },
    });
  }
  audit.record({ action: "system.started", actor: { kind: "system" }, outcome: "succeeded", details: { version: serverVersion() } });
}

/**
 * Starts the service: config, logger, master key, database (pre-migration backup and migrations,
 * all before listening), settings, the app, listen, then READY=1 to systemd.
 */
export async function startServer(environment: NodeJS.ProcessEnv, options: StartOptions = {}): Promise<ServerHandle> {
  const clock = options.clock ?? systemClock;
  let logger: Logger = createLogger({ logLevel: "info" }, options.logDestination);
  let database: Database | undefined;
  let app: FastifyInstance | undefined;
  let jobs: JobScheduler | undefined;
  try {
    const config = loadConfig(environment);
    logger = createLogger(config, options.logDestination);
    // Refuse to start without a valid master key; the sign-in limits hash unknown identifiers with it.
    const secrets = createSecrets(loadMasterKey(environment));
    const webRoot = options.webRoot === undefined ? defaultWebRoot : options.webRoot;
    if (webRoot !== null) checkWebRoot(webRoot);

    const prepared = prepareDatabase(config, {
      clock,
      logger,
      ...(options.migrationsFolder === undefined ? {} : { migrationsFolder: options.migrationsFolder }),
    });
    database = prepared.database;
    const settings = createSettingsService({ db: database.db, clock, logger });
    const services = createServices({
      db: database.db,
      clock,
      logger,
      settings,
      resourceRoots: { dataDir: config.dataDir, ...allowFromUiOf(config) },
      secrets,
      publicOrigin: config.publicOrigin,
      signInGate: (dependencies) => createSignInLimits({ ...dependencies, secrets }),
      updates: { check: config.updateCheck, fromUi: config.updateFromUi },
    });
    // Before listening: a resource whose folder went away or changed answers as unavailable.
    await services.resources.checkAtStartup();
    // An update from Settings that ended while no server ran (this one's own, or a rollback) is recorded now.
    await services.updates.recordFinished();
    jobs = createJobScheduler({ clock, logger, timers: systemTimers });
    scheduleAuditRetention(jobs, services.audit);
    scheduleSignInLimitsSweep(jobs, { db: database.db, clock });
    scheduleSecondFactorsSweep(jobs, services);
    scheduleSsoFlowsPurge(jobs, services.sso.flows);
    scheduleUploadsCleanup(jobs, services.files);
    scheduleShareLinkUnlocksPurge(jobs, services.shareLinks);
    scheduleResourceRetries(jobs, services.resources);
    scheduleUpdateChecks(jobs, services.updates);
    app = await buildApp(config, { logger, services, clock, ...(webRoot === null ? {} : { webRoot }) });
    await listen(app, config.listenHost, config.listenPort);
    jobs.start();
    recordStart(services.audit, prepared.migration);
    await notifyReady({ environment, logger, ...options.notify });

    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.listenPort;
    const openApp = app;
    const openDatabase = database;
    const openJobs = jobs;
    return {
      app: openApp,
      port,
      close: async () => {
        openJobs.stop();
        await openApp.close();
        openDatabase.sqlite.close();
      },
    };
  } catch (error) {
    logger.fatal({ problem: describe(error), err: error }, `The server could not start: ${describe(error)}`);
    jobs?.stop();
    await app?.close().catch(() => undefined);
    database?.sqlite.close();
    throw new StartupError(describe(error), { cause: error });
  }
}

/** Shuts down gracefully on SIGTERM (systemd stop) and SIGINT. */
export function closeOnSignals(handle: ServerHandle): void {
  const stop = (signal: NodeJS.Signals): void => {
    handle.app.log.info({ signal }, "Shutting down");
    handle.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        handle.app.log.error({ err: error }, "Shutdown failed");
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.main) {
  try {
    const handle = await startServer(process.env);
    handleProcessErrors(process, { logger: handle.app.log, exit: (code) => process.exit(code) });
    closeOnSignals(handle);
  } catch {
    // startServer has logged the problem.
    process.exitCode = 1;
  }
}
