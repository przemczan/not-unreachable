import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeClock, makeTempDir, type FakeClock, migrationsUpTo, migrationsWithExtra, silentLogger } from "../../test-support/index.ts";
import { openDatabase, type Database } from "./database.ts";
import { migrateDatabase, pendingMigrations, prepareDatabase } from "./migrations.ts";

function tableExists(database: Database, name: string): boolean {
  return database.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

describe("migrateDatabase", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let backupsDir: string;
  let database: Database;
  let clock: FakeClock;

  beforeEach(() => {
    clock = fakeClock();
    temp = makeTempDir();
    backupsDir = join(temp.dir, "backups");
    database = prepareEmpty();
  });
  afterEach(() => {
    database.sqlite.close();
    temp.cleanup();
  });

  function prepareEmpty(): Database {
    mkdirSync(backupsDir, { recursive: true });
    return openDatabase(join(temp.dir, "test.sqlite"));
  }

  const backups = (): string[] => readdirSync(backupsDir).toSorted();

  it("applies the first migration to an empty database after a pre-migration backup", () => {
    expect(tableExists(database, "settings")).toBe(false);
    const result = migrateDatabase(database, { backupsDir, clock, logger: silentLogger });
    expect(result.applied.map((entry) => entry.tag)).toContain("0000_settings");
    expect(tableExists(database, "settings")).toBe(true);
    expect(result.backupFile).toBe(join(backupsDir, "pre-migration-20261124T101500000Z.sqlite"));
    expect(backups()).toEqual(["pre-migration-20261124T101500000Z.sqlite"]);
    expect(pendingMigrations(database)).toEqual([]);
  });

  it("writes no backup and applies nothing when the schema is up to date", () => {
    migrateDatabase(database, { backupsDir, clock, logger: silentLogger });
    const before = backups();
    const result = migrateDatabase(database, { backupsDir, clock, logger: silentLogger });
    expect(result).toEqual({ applied: [], backupFile: undefined, removedBackups: [] });
    expect(backups()).toEqual(before);
  });

  it("throws on a failing migration, keeps the old data and leaves the backup", () => {
    migrateDatabase(database, { backupsDir, clock, logger: silentLogger });
    database.sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('globalRateLimit', '{}', 'now')").run();
    const broken = migrationsWithExtra(
      join(temp.dir, "broken-migrations"),
      "0001_broken",
      "CREATE TABLE `half_done` (`id` text);\n--> statement-breakpoint\nTHIS IS NOT SQL;\n",
    );
    clock.advance(60_000);

    expect(() => migrateDatabase(database, { backupsDir, clock, logger: silentLogger, migrationsFolder: broken })).toThrow(/NOT SQL/);

    expect(tableExists(database, "half_done")).toBe(false);
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM settings").get()).toEqual({ n: 1 });
    expect(backups()).toContain("pre-migration-20261124T101600000Z.sqlite");
    expect(pendingMigrations(database, broken).map((entry) => entry.tag)).toEqual(["0001_broken"]);

    const backup = openDatabase(join(backupsDir, "pre-migration-20261124T101600000Z.sqlite"));
    try {
      expect(backup.sqlite.prepare("SELECT key FROM settings").all()).toEqual([{ key: "globalRateLimit" }]);
    } finally {
      backup.sqlite.close();
    }
  });

  it("keeps every user, session and linked sign-in when 0005 rebuilds the users table", () => {
    migrateDatabase(database, {
      backupsDir,
      clock,
      logger: silentLogger,
      migrationsFolder: migrationsUpTo(join(temp.dir, "up-to-0004"), "0004_sso"),
    });
    const { sqlite } = database;
    sqlite
      .prepare(
        "INSERT INTO users (id, username, email, display_name, role, status, created_at) VALUES ('u1', 'ann', 'ann@example.com', 'Ann', 'user', 'active', 'then')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO sessions (id, token_hash, user_id, state, created_at, last_seen_at) VALUES ('s1', 'h', 'u1', 'active', 'then', 'then')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO sso_providers (id, kind, name, issuer, client_id, client_secret, enabled, created_at, updated_at) VALUES ('p1', 'oidc', 'IdP', 'https://idp.test', 'c', 'x', 1, 'then', 'then')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO linked_sign_ins (id, user_id, provider_id, issuer, subject, created_at) VALUES ('l1', 'u1', 'p1', 'https://idp.test', 'sub', 'then')",
      )
      .run();

    clock.advance(1000);
    const result = migrateDatabase(database, { backupsDir, clock, logger: silentLogger });
    expect(result.applied.map((entry) => entry.tag)).toEqual([
      "0005_invitations_and_mail",
      "0006_passkeys",
      "0007_uploads",
      "0008_share_links",
      "0009_smb_shares",
      "0010_share_link_access",
      "0011_invitation_email_options",
      "0012_updates",
    ]);
    const ids = (table: string) => sqlite.prepare(`SELECT id FROM ${table}`).all();
    expect(ids("users")).toEqual([{ id: "u1" }]);
    expect(ids("sessions")).toEqual([{ id: "s1" }]);
    expect(ids("linked_sign_ins")).toEqual([{ id: "l1" }]);
    // A user's email is optional now.
    sqlite
      .prepare(
        "INSERT INTO users (id, username, display_name, role, status, created_at) VALUES ('u2', 'bo', 'Bo', 'user', 'active', 'then')",
      )
      .run();
    expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("deletes older pre-migration backups after a successful migration", () => {
    migrateDatabase(database, { backupsDir, clock, logger: silentLogger });
    const next = migrationsWithExtra(join(temp.dir, "next-migrations"), "0001_next", "CREATE TABLE `next_table` (`id` text);\n");
    clock.advance(1000);
    const result = migrateDatabase(database, { backupsDir, clock, logger: silentLogger, migrationsFolder: next });
    expect(result.applied.map((entry) => entry.tag)).toEqual(["0001_next"]);
    expect(tableExists(database, "next_table")).toBe(true);
    expect(backups()).toEqual(["pre-migration-20261124T101501000Z.sqlite"]);
    expect(result.removedBackups).toHaveLength(1);
  });
});

describe("prepareDatabase", () => {
  it("creates the data directories (0700) and the database file (0600), then migrates", () => {
    const temp = makeTempDir();
    try {
      const dataDir = join(temp.dir, "data");
      const { database, paths, migration } = prepareDatabase({ dataDir }, { clock: fakeClock(), logger: silentLogger });
      try {
        expect(paths.databaseFile).toBe(join(dataDir, "db", "not-unreachable.sqlite"));
        for (const dir of [dataDir, paths.databaseDir, paths.backupsDir, paths.uploadsDir]) {
          expect(statSync(dir).mode & 0o777).toBe(0o700);
        }
        expect(statSync(paths.databaseFile).mode & 0o777).toBe(0o600);
        expect(statSync(migration.backupFile ?? "").mode & 0o777).toBe(0o600);
        expect(tableExists(database, "settings")).toBe(true);
        expect(database.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(database.sqlite.pragma("secure_delete", { simple: true })).toBe(1);
        expect(database.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
        expect(database.sqlite.pragma("synchronous", { simple: true })).toBe(1);
      } finally {
        database.sqlite.close();
      }
      expect(existsSync(join(dataDir, "uploads"))).toBe(true);
    } finally {
      temp.cleanup();
    }
  });
});
