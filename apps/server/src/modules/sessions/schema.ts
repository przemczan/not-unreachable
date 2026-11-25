import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "../accounts/index.ts";

/** Server-side sessions (threat model, T2); the cookie's token is stored only as its SHA-256. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: text("state", { enum: ["pending_second_factor", "active"] }).notNull(),
    createdAt: text("created_at").notNull(),
    /** Written at most once a minute. */
    lastSeenAt: text("last_seen_at").notNull(),
    /** When the password or a factor was last proved in this session. */
    recentSignInAt: text("recent_sign_in_at"),
    /** How the first step was passed, for the `sign-in.succeeded` the second step records; `passkey` passes both at once. */
    signInMethod: text("sign_in_method", { enum: ["password", "sso", "passkey"] })
      .notNull()
      .default("password"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: text("revoked_at"),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export type SessionRow = typeof sessions.$inferSelect;
