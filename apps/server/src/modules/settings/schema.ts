import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Typed instance settings; `value` is JSON validated by the registry's schema. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  /** UTC ISO-8601. */
  updatedAt: text("updated_at").notNull(),
  /** The account that changed it; null for the system. */
  updatedBy: text("updated_by"),
});

export type SettingRow = typeof settings.$inferSelect;
