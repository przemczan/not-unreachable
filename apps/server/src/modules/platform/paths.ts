import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** Where the server keeps its data under `DATA_DIR` (deployment.md, "Config, secrets and data"). */
export interface DataPaths {
  readonly dataDir: string;
  readonly databaseDir: string;
  readonly databaseFile: string;
  readonly backupsDir: string;
  readonly uploadsDir: string;
}

export function dataPaths(config: Pick<Config, "dataDir">): DataPaths {
  const databaseDir = join(config.dataDir, "db");
  return {
    dataDir: config.dataDir,
    databaseDir,
    databaseFile: join(databaseDir, "not-unreachable.sqlite"),
    backupsDir: join(config.dataDir, "backups"),
    uploadsDir: join(config.dataDir, "uploads"),
  };
}

/** Creates the data directories (mode 0700) that don't exist yet. Existing ones keep their mode. */
export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.dataDir, paths.databaseDir, paths.backupsDir, paths.uploadsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
