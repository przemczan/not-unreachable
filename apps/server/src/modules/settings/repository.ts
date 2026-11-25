import { eq } from "drizzle-orm";
import type { Db } from "../platform/index.ts";
import { settings, type SettingRow } from "./schema.ts";

export interface SettingsRepository {
  find(key: string): SettingRow | undefined;
  upsert(row: SettingRow): void;
}

export function createSettingsRepository(db: Db): SettingsRepository {
  return {
    find(key) {
      return db.select().from(settings).where(eq(settings.key, key)).get();
    },
    upsert(row) {
      db.insert(settings)
        .values(row)
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
        })
        .run();
    },
  };
}
