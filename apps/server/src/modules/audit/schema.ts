import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Append-only (threat model, T12): nothing updates a row, and only the retention purge deletes. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    /** UTC ISO-8601. */
    at: text("at").notNull(),
    actorKind: text("actor_kind", { enum: ["account", "share-link", "anonymous", "system"] }).notNull(),
    actorAccountId: text("actor_account_id"),
    /** The actor's username when the event happened, so the log reads the same after the account is gone. */
    actorUsername: text("actor_username"),
    action: text("action").notNull(),
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    outcome: text("outcome", { enum: ["succeeded", "failed", "denied"] }).notNull(),
    ip: text("ip"),
    /** The first 256 characters. */
    userAgent: text("user_agent"),
    /** JSON, validated by the action's details schema; never a secret. */
    details: text("details").notNull(),
  },
  (table) => [
    index("audit_events_at_idx").on(table.at),
    index("audit_events_action_idx").on(table.action, table.at),
    index("audit_events_actor_idx").on(table.actorAccountId, table.at),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
