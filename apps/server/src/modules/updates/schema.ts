import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The one row's id: the check is instance-wide. */
export const UPDATE_CHECK_ID = 1;

/**
 * The last answer GitHub gave to the release check, and a later check that failed (deployment.md,
 * "Updating from Settings"), kept so a restart doesn't ask again. One row (id 1) once the server
 * first asked.
 */
export const updateChecks = sqliteTable("update_checks", {
  id: integer("id").primaryKey(),
  /** The latest release as validated (`KeptRelease`, JSON); null until GitHub first answered. */
  release: text("release"),
  /** UTC ISO-8601: when GitHub last answered. */
  checkedAt: text("checked_at"),
  /** UTC ISO-8601: a check after `checked_at` that failed; null once one succeeds again. */
  failedAt: text("failed_at"),
});

export type UpdateCheckRow = typeof updateChecks.$inferSelect;

/**
 * Every install request the server accepted, so whichever server sees it finished first records
 * `update.finished` once, with the admin who asked as its actor.
 */
export const updateRequests = sqliteTable("update_requests", {
  requestId: text("request_id").primaryKey(),
  /** The admin who asked, and their username then, for the audit actor. */
  accountId: text("account_id").notNull(),
  username: text("username").notNull(),
  fromVersion: text("from_version").notNull(),
  toVersion: text("to_version").notNull(),
  /** UTC ISO-8601. */
  startedAt: text("started_at").notNull(),
  /** When the verify unit took it (exit 0); from then on only the status file tells how it ends. */
  handedOverAt: text("handed_over_at"),
  /** The server's own end of it, before any hand-over (`refused`); null otherwise. */
  result: text("result"),
  reason: text("reason"),
  finishedAt: text("finished_at"),
  /** When `update.finished` was recorded; null until then. */
  recordedAt: text("recorded_at"),
});

export type UpdateRequestRow = typeof updateRequests.$inferSelect;
