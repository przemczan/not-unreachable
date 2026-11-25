import { chmodSync, closeSync, openSync, rmSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export type Sqlite = BetterSqlite3.Database;
export type Db = BetterSQLite3Database;

/** The open database: the raw better-sqlite3 handle and its Drizzle wrapper. */
export interface Database {
  readonly sqlite: Sqlite;
  readonly db: Db;
}

export const IN_MEMORY = ":memory:";

/** Opens (creating if needed, mode 0600) the SQLite file with the PRAGMAs of stack.md, "Database". */
export function openDatabase(file: string): Database {
  if (file !== IN_MEMORY) {
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
  }
  const sqlite = new BetterSqlite3(file);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("secure_delete = ON");
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { sqlite, db: drizzle({ client: sqlite }) };
}

/** Quotes a string as an SQL literal (single quotes doubled), for statements that take no parameters. */
export function sqlStringLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("SQL string literal must not contain NUL");
  return `'${value.replaceAll("'", "''")}'`;
}

/** `VACUUM INTO` a new file (mode 0600): a consistent copy, safe while the database is in use. */
export function vacuumInto(database: Database, file: string): void {
  // Create the target empty first (fails if it exists) so the copy never exists with a wider mode.
  closeSync(openSync(file, "wx", 0o600));
  try {
    database.sqlite.exec(`VACUUM INTO ${sqlStringLiteral(file)}`);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}
