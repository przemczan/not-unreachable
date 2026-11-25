import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { z } from "zod";
import { listMatching } from "./backups.ts";
import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import { openDatabase, vacuumInto, type Database } from "./database.ts";
import type { Logger } from "./logger.ts";
import { dataPaths, ensureDataDirs, type DataPaths } from "./paths.ts";
import { FILE_TIMESTAMP_PATTERN, fileTimestamp } from "./timestamps.ts";

/** `apps/server/drizzle`, the same depth from `src/modules/platform/` and `dist/modules/platform/`. */
export const defaultMigrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

const MIGRATIONS_TABLE = "__drizzle_migrations";
const preMigrationBackupName = new RegExp(`^pre-migration-${FILE_TIMESTAMP_PATTERN}\\.sqlite$`);

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number() })),
});

const lastRow = z.object({ last: z.union([z.number(), z.string(), z.null()]) });

export interface MigrationEntry {
  readonly tag: string;
  /** The migration's `when` (ms) in the journal, which drizzle stores as `created_at`. */
  readonly when: number;
}

export interface MigrationResult {
  readonly applied: readonly MigrationEntry[];
  /** The pre-migration backup, written only when migrations were pending. */
  readonly backupFile: string | undefined;
  /** Older pre-migration backups deleted after the successful migration. */
  readonly removedBackups: readonly string[];
}

export interface MigrateOptions {
  readonly migrationsFolder?: string;
  readonly backupsDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The journal's migrations that the database hasn't applied yet, by drizzle's own rule (`created_at` < `when`). */
export function pendingMigrations(database: Database, migrationsFolder: string = defaultMigrationsFolder): MigrationEntry[] {
  const journal = journalSchema.parse(JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")));
  const last = lastAppliedMillis(database);
  return journal.entries.filter((entry) => last === undefined || last < entry.when).map(({ tag, when }) => ({ tag, when }));
}

function lastAppliedMillis(database: Database): number | undefined {
  const table = database.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATIONS_TABLE);
  if (table === undefined) return undefined;
  const row = lastRow.parse(database.sqlite.prepare(`SELECT max(created_at) AS last FROM "${MIGRATIONS_TABLE}"`).get());
  return row.last === null ? undefined : Number(row.last);
}

/**
 * Applies pending migrations. Before any, writes `pre-migration-<UTC timestamp>.sqlite`; after
 * success, deletes older pre-migration backups. A failed migration throws, is rolled back, and
 * leaves its backup in place.
 */
export function migrateDatabase(database: Database, options: MigrateOptions): MigrationResult {
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder;
  const pending = pendingMigrations(database, migrationsFolder);
  if (pending.length === 0) {
    options.logger.info("Database schema is up to date");
    return { applied: [], backupFile: undefined, removedBackups: [] };
  }

  const backupFile = join(options.backupsDir, `pre-migration-${fileTimestamp(options.clock.now())}.sqlite`);
  vacuumInto(database, backupFile);
  options.logger.info({ backupFile, pending: pending.map((entry) => entry.tag) }, "Wrote pre-migration backup");

  try {
    migrateWithoutForeignKeyActions(database, migrationsFolder);
  } catch (error) {
    options.logger.error({ err: error, backupFile }, "Migration failed; the database was rolled back");
    throw error;
  }

  const removedBackups = listMatching(options.backupsDir, preMigrationBackupName).filter((file) => file !== backupFile);
  for (const file of removedBackups) rmSync(file, { force: true });
  options.logger.info({ applied: pending.map((entry) => entry.tag) }, "Applied database migrations");
  return { applied: pending, backupFile, removedBackups };
}

/**
 * Runs drizzle's migrations with foreign keys off, as SQLite's table rebuild procedure requires
 * (https://sqlite.org/lang_altertable.html#otheralter): drizzle-kit rebuilds a table to change a
 * column, and with them on, its `DROP TABLE` would cascade into every table that references it.
 * The `PRAGMA foreign_keys=OFF` drizzle-kit writes does nothing inside the migration's
 * transaction, so it is switched here, outside it. drizzle commits the migrations itself, so a
 * migration that leaves a reference dangling fails after its commit: the pre-migration backup is
 * the way back then.
 */
function migrateWithoutForeignKeyActions(database: Database, migrationsFolder: string): void {
  const { sqlite } = database;
  sqlite.pragma("foreign_keys = OFF");
  try {
    migrate(database.db, { migrationsFolder });
    const violations: unknown = sqlite.pragma("foreign_key_check");
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error(`The migrations left ${violations.length} foreign key violation(s); restore the pre-migration backup`);
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}

export interface PrepareOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly migrationsFolder?: string;
}

export interface PreparedDatabase {
  readonly database: Database;
  readonly paths: DataPaths;
  readonly migration: MigrationResult;
}

/** Creates the data directories, opens the database and migrates it: what both startup and `not-unreachable migrate` run. */
export function prepareDatabase(config: Pick<Config, "dataDir">, options: PrepareOptions): PreparedDatabase {
  const paths = dataPaths(config);
  ensureDataDirs(paths);
  const database = openDatabase(paths.databaseFile);
  try {
    const migration = migrateDatabase(database, {
      backupsDir: paths.backupsDir,
      clock: options.clock,
      logger: options.logger,
      ...(options.migrationsFolder === undefined ? {} : { migrationsFolder: options.migrationsFolder }),
    });
    return { database, paths, migration };
  } catch (error) {
    database.sqlite.close();
    throw error;
  }
}
