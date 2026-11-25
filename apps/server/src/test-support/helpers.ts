import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { z } from "zod";
import {
  createLogger,
  defaultMigrationsFolder,
  migrateDatabase,
  openDatabase,
  type Clock,
  type Database,
  type Logger,
} from "../modules/platform/index.ts";

const logLine = z.record(z.string(), z.unknown());
const journalSchema = z.looseObject({
  entries: z.array(z.object({ idx: z.number(), version: z.string(), when: z.number(), tag: z.string(), breakpoints: z.boolean() })),
});

/** A temp directory removed by `cleanup`. */
export function makeTempDir(prefix = "nu-test-"): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface FakeClock extends Clock {
  advance(milliseconds: number): void;
}

export function fakeClock(start = "2026-11-24T10:15:00.000Z"): FakeClock {
  let time = new Date(start).getTime();
  return {
    now: () => new Date(time),
    advance: (milliseconds) => {
      time += milliseconds;
    },
  };
}

/** A logger whose JSON lines are kept in `lines`. */
export function captureLogger(level: "trace" | "debug" | "info" | "warn" = "info"): {
  readonly logger: Logger;
  readonly lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ logLevel: level }, destination);
  return {
    logger,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => logLine.parse(JSON.parse(line))),
  };
}

export const silentLogger: Logger = createLogger({ logLevel: "silent" });

/** An in-memory database with every migration applied. */
export function migratedMemoryDatabase(backupsDir: string, clock: Clock): Database {
  const database = openDatabase(":memory:");
  migrateDatabase(database, { backupsDir, clock, logger: silentLogger });
  return database;
}

/** Copies the real migrations into `target` with the journal cut after `lastTag`, for a database of that older schema. */
export function migrationsUpTo(target: string, lastTag: string): string {
  cpSync(defaultMigrationsFolder, target, { recursive: true });
  const journalFile = join(target, "meta", "_journal.json");
  const journal = journalSchema.parse(JSON.parse(readFileSync(journalFile, "utf8")));
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`No migration ${lastTag}`);
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }, null, 2));
  return target;
}

/** Copies the real migrations into `target` and appends a migration with the given SQL. */
export function migrationsWithExtra(target: string, tag: string, sql: string): string {
  cpSync(defaultMigrationsFolder, target, { recursive: true });
  const journalFile = join(target, "meta", "_journal.json");
  const journal = journalSchema.parse(JSON.parse(readFileSync(journalFile, "utf8")));
  const last = journal.entries.at(-1);
  if (last === undefined) throw new Error("the real migrations folder has no migrations");
  journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1, tag, breakpoints: true });
  writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  writeFileSync(join(target, `${tag}.sql`), sql);
  return target;
}
