import { smtpTlsModes } from "@not-unreachable/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { mailSettings, SMTP_SETTINGS_ID, storedTlsModes, type MailSettingsRow } from "./schema.ts";

// The stored modes are literals (schema.ts); fail at load if they ever drift from the contracts'.
if (storedTlsModes.join() !== smtpTlsModes.join()) throw new Error("mail_settings.tls_mode must list the contracts' TLS modes");

export interface MailRepository {
  /** The SMTP settings, once the admin has set them. */
  find(): MailSettingsRow | undefined;
  /** Inserts the one row or replaces it. */
  save(row: MailSettingsRow): void;
}

export function createMailRepository(db: Db): MailRepository {
  return {
    find() {
      return db.select().from(mailSettings).where(eq(mailSettings.id, SMTP_SETTINGS_ID)).get();
    },
    save(row) {
      db.insert(mailSettings).values(row).onConflictDoUpdate({ target: mailSettings.id, set: row }).run();
    },
  };
}
