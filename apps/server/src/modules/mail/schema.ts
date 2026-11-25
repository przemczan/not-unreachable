import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// A literal, not the contracts' array: drizzle-kit loads this file without the contracts package.
// repository.ts checks it equals the contracts' `smtpTlsModes`.
export const storedTlsModes = ["starttls", "tls", "none"] as const;

/** The one row's id: the SMTP settings are instance-wide. */
export const SMTP_SETTINGS_ID = "smtp";

/**
 * The SMTP settings, one row (id `smtp`) once the admin sets them. The password is a `secrets`
 * envelope (purpose `smtp`, AAD `mail_settings:password:smtp`) that `rotate-key` re-encrypts
 * (threat model, T6).
 */
export const mailSettings = sqliteTable("mail_settings", {
  id: text("id").primaryKey(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  tlsMode: text("tls_mode", { enum: storedTlsModes }).notNull(),
  username: text("username"),
  password: text("password"),
  fromAddress: text("from_address").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type MailSettingsRow = typeof mailSettings.$inferSelect;
