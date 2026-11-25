import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Every account, the admin included (role `admin`). Sign-in methods live in tables of their own,
 * keyed by `user_id`, so a new kind of credential never changes this table.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Lowercase `[a-z0-9._-]{3,32}`; never changes. */
    username: text("username").notNull().unique(),
    /** Stored lowercase, so sign-in by email ignores case. Always set for the admin; optional for a user. */
    email: text("email").unique(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "user"] }).notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    /** The most bytes the account's home may hold; null takes the `defaultQuotaBytes` setting. */
    quotaBytes: integer("quota_bytes"),
    createdAt: text("created_at").notNull(),
    disabledAt: text("disabled_at"),
  },
  // Exactly one admin exists (domain.md, Glossary): the database refuses a second.
  (table) => [
    uniqueIndex("users_one_admin_idx")
      .on(table.role)
      .where(sql`role = 'admin'`),
  ],
);

export type UserRow = typeof users.$inferSelect;

/** An account's password, as an argon2id PHC string. Only the admin has one. */
export const passwordCredentials = sqliteTable("password_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  hash: text("hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type PasswordCredentialRow = typeof passwordCredentials.$inferSelect;

/** One-time setup links from the CLI: valid 1 hour, single use, stored only as SHA-256. */
export const setupTokens = sqliteTable("setup_tokens", {
  id: text("id").primaryKey(),
  purpose: text("purpose", { enum: ["first-run", "admin-reset"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  /** The admin whose password an `admin-reset` token sets; null for `first-run`. */
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

export type SetupTokenRow = typeof setupTokens.$inferSelect;
