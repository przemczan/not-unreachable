import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Literals, not the contracts' arrays: drizzle-kit loads this file without the contracts package.
// repository.ts checks they equal the contracts'.
export const storedKinds = ["local", "smb"] as const;
export const storedStates = ["available", "unavailable"] as const;
export const storedReasons = [
  "missing",
  "not-a-folder",
  "changed",
  "not-writable",
  "auth",
  "unreachable",
  "no-share",
  "not-supported",
  "mount-failed",
  "helper-unavailable",
] as const;
export const storedSmbProtocols = ["3.1.1", "3.0", "2.1"] as const;

/**
 * Every resource the admin mapped. The columns of one kind stay null on the others' rows; each kind
 * adds its own (`local_path`, `smb_*`), so a new kind never changes the common ones.
 */
export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    kind: text("kind", { enum: storedKinds }).notNull(),
    /** `local`: the path as the admin typed it. */
    localPath: text("local_path"),
    /** `smb`: the connection settings (smb.md); the share is mounted at the mount root's `<id>/`. */
    smbHost: text("smb_host"),
    smbShare: text("smb_share"),
    /** "" for the share's top folder. */
    smbSubfolder: text("smb_subfolder"),
    smbUsername: text("smb_username"),
    /** A secrets envelope (`smb`, AAD `resources:smb_password:<id>`), never the password (threat model, T6). */
    smbPassword: text("smb_password"),
    /** "" when the server needs none. */
    smbDomain: text("smb_domain"),
    smbProtocol: text("smb_protocol", { enum: storedSmbProtocols }),
    smbEncrypt: integer("smb_encrypt", { mode: "boolean" }),
    /** The root's real path, fixed when it was saved; startup and Retry check it is still the same. */
    rootRealpath: text("root_realpath").notNull(),
    isHomeRoot: integer("is_home_root", { mode: "boolean" }).notNull().default(false),
    /** Set only on the home root's row: the folder inside it that holds the homes; "" for its top folder. */
    homeRootSubpath: text("home_root_subpath"),
    state: text("state", { enum: storedStates }).notNull(),
    unavailableReason: text("unavailable_reason", { enum: storedReasons }),
    createdAt: text("created_at").notNull(),
  },
  // One home root at most: the database refuses a second.
  (table) => [
    uniqueIndex("resources_one_home_root_idx")
      .on(table.isHomeRoot)
      .where(sql`is_home_root = 1`),
  ],
);

export type ResourceRow = typeof resources.$inferSelect;
export type NewResourceRow = typeof resources.$inferInsert;

/**
 * Each user's home, recorded where it was made: a later home root change never moves it.
 */
export const homes = sqliteTable("homes", {
  username: text("username").primaryKey(),
  resourceId: text("resource_id")
    .notNull()
    .references(() => resources.id, { onDelete: "restrict" }),
  /** Relative to the resource's root, such as `homes/alice`. */
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
});

export type HomeRow = typeof homes.$inferSelect;
