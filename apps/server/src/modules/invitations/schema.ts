import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "../accounts/index.ts";

// A literal: drizzle-kit loads this file without the contracts package.
export const storedInvitationKinds = ["invite", "relink"] as const;

/**
 * Invitations, and re-link links (kind `relink`, for `target_user_id`): single use, expiring,
 * revocable (threat model, T1). The token is stored as its SHA-256 (`token_hash`), and as an
 * envelope (`token`, purpose `invitation`, AAD `invitations:token:<id>`) so the admin can copy the
 * link again; `rotate-key` re-encrypts it. Accepting claims the row with one conditional UPDATE.
 */
export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: storedInvitationKinds }).notNull(),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    token: text("token").notNull(),
    /**
     * Who it is meant for, lowercase. It never links a sign-in; with `verify_email`, accepting needs
     * a provider-verified email equal to it (threat model, T9).
     */
    email: text("email"),
    /** The admin chose to email it; only these are sent again. Always false for re-link links. */
    sendByEmail: integer("send_by_email", { mode: "boolean" }).notNull().default(false),
    /** Accepting needs a provider-verified email equal to `email`; true whenever `send_by_email` is. */
    verifyEmail: integer("verify_email", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: text("expires_at").notNull(),
    acceptedUserId: text("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("invitations_kind_created_idx").on(table.kind, table.createdAt),
    index("invitations_target_idx").on(table.targetUserId),
  ],
);

export type InvitationRow = typeof invitations.$inferSelect;

/**
 * Usernames of removed users whose home was kept: no new account may take one while its folder
 * still exists, so a new user never inherits someone else's files. Dropped once the folder is gone.
 */
export const reservedUsernames = sqliteTable("reserved_usernames", {
  username: text("username").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export type ReservedUsernameRow = typeof reservedUsernames.$inferSelect;
