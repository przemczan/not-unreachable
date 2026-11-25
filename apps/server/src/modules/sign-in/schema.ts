import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/*
 * Both tables are keyed by a subject key (`subjectKeyOf` in `limits.ts`): the account when the identifier
 * names one, otherwise a keyed hash of the identifier, so unknown identifiers are delayed and
 * locked exactly like accounts (threat model, T1 and T11). No foreign key, as most subjects are no
 * account; the sweep job removes rows past their window.
 */

/** Failures for one subject from one IP (IPv6 by /64), which delay that IP's next attempts (T11). */
export const signInFailures = sqliteTable(
  "sign_in_failures",
  {
    subjectKey: text("subject_key").notNull(),
    ipKey: text("ip_key").notNull(),
    failures: integer("failures").notNull(),
    lastFailureAt: text("last_failure_at").notNull(),
    /** No attempt from this IP for this subject is checked before then. */
    delayedUntil: text("delayed_until"),
  },
  (table) => [primaryKey({ columns: [table.subjectKey, table.ipKey] })],
);

export type SignInFailureRow = typeof signInFailures.$inferSelect;

/** Failures for one subject from any IP in the current hour, and the temporary lock they lead to (T11). */
export const signInLocks = sqliteTable("sign_in_locks", {
  subjectKey: text("subject_key").primaryKey(),
  windowStartedAt: text("window_started_at").notNull(),
  failures: integer("failures").notNull(),
  lockedUntil: text("locked_until"),
});

export type SignInLockRow = typeof signInLocks.$inferSelect;
