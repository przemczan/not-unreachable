import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import { vacuumInto, type Database } from "./database.ts";
import { FILE_TIMESTAMP_PATTERN, fileTimestamp } from "./timestamps.ts";

/** How many scheduled backups `not-unreachable backup` keeps (deployment.md, "Backups"). */
export const KEPT_BACKUPS = 7;

const backupName = new RegExp(`^not-unreachable-${FILE_TIMESTAMP_PATTERN}\\.sqlite$`);

export interface BackupResult {
  /** The new backup's path. */
  readonly file: string;
  /** Older backups deleted to keep the newest {@link KEPT_BACKUPS}. */
  readonly removed: readonly string[];
}

/** Writes `not-unreachable-<UTC timestamp>.sqlite` with `VACUUM INTO`, then keeps only the newest 7 (pre-migration backups are never touched). */
export function backupDatabase(database: Database, backupsDir: string, clock: Clock): BackupResult {
  const file = join(backupsDir, `not-unreachable-${fileTimestamp(clock.now())}.sqlite`);
  vacuumInto(database, file);
  const backups = listMatching(backupsDir, backupName);
  const removed = backups.slice(0, Math.max(0, backups.length - KEPT_BACKUPS));
  for (const old of removed) rmSync(old, { force: true });
  return { file, removed };
}

/** The files in `dir` whose names match, oldest first (the names sort in time order). */
export function listMatching(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .toSorted()
    .map((name) => join(dir, name));
}
