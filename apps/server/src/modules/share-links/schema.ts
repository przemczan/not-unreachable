import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "../accounts/index.ts";
import { resources } from "../resources/index.ts";

// Literals, not the contracts' array: drizzle-kit loads this file without the contracts package.
// repository.ts checks they equal the contracts'.
export const storedShareLinkKinds = ["file", "folder"] as const;
export const storedShareLinkAccesses = ["anyone", "signed-in", "selected-users"] as const;

/**
 * Share links (threat model, T8). The token is stored as its SHA-256 (`token_hash`), and as an
 * envelope (`token`, purpose `share-link`, AAD `share_links:token:<id>`) so the admin can copy the
 * link again; `rotate-key` re-encrypts it. `locked_until` is set for an hour after too many wrong
 * passwords. Removing the resource removes its links. `access` is who may open it; a link made before
 * link access existed is open to anyone, as it was.
 */
export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    token: text("token").notNull(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    /** Inside the resource, as `storage.resolveInResource` normalised it. */
    path: text("path").notNull(),
    /** What the path held when the link was made; a link whose item no longer is one answers as gone. */
    kind: text("kind", { enum: storedShareLinkKinds }).notNull(),
    /** argon2id, as the accounts module's hasher makes it; null for a link anyone holding it may open. */
    passwordHash: text("password_hash"),
    access: text("access", { enum: storedShareLinkAccesses }).notNull().default("anyone"),
    /** Null only for a link made with "No expiry", picked on purpose. */
    expiresAt: text("expires_at"),
    lockedUntil: text("locked_until"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
    downloadCount: integer("download_count").notNull().default(0),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [index("share_links_created_idx").on(table.createdAt, table.id), index("share_links_resource_idx").on(table.resourceId)],
);

export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type NewShareLinkRow = typeof shareLinks.$inferInsert;

/**
 * The users a "Selected users" link was shared with. Removing the user takes them off every list; a
 * list left empty keeps the link "Selected users", which then only the admin can open.
 */
export const shareLinkUsers = sqliteTable(
  "share_link_users",
  {
    shareLinkId: text("share_link_id")
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.shareLinkId, table.userId] }), index("share_link_users_user_idx").on(table.userId)],
);

/**
 * Unlocks: a correct link password gives the browser a random token in `__Host-nu_unlock_<linkId>`,
 * stored here as its SHA-256. Any change of the link's password deletes them all; a daily job purges
 * expired ones.
 */
export const shareLinkUnlocks = sqliteTable(
  "share_link_unlocks",
  {
    id: text("id").primaryKey(),
    shareLinkId: text("share_link_id")
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    unlockHash: text("unlock_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("share_link_unlocks_link_idx").on(table.shareLinkId), index("share_link_unlocks_expires_idx").on(table.expiresAt)],
);

export type ShareLinkUnlockRow = typeof shareLinkUnlocks.$inferSelect;
