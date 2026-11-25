import type { Clock, Logger } from "../platform/index.ts";
import { settingsRegistry, type SettingKey, type SettingValue } from "./registry.ts";
import type { SettingsRepository } from "./repository.ts";

/** Thrown by `set` when a value doesn't match its setting's schema. */
export class InvalidSettingError extends Error {
  override readonly name = "InvalidSettingError";
  readonly key: SettingKey;
  readonly issues: readonly string[];

  constructor(key: SettingKey, issues: readonly string[]) {
    super(`Invalid value for setting ${key}: ${issues.join("; ")}`);
    this.key = key;
    this.issues = issues;
  }
}

export interface SettingsService {
  /** The stored value, or the default when it's absent or no longer valid. */
  get<K extends SettingKey>(key: K): SettingValue<K>;
  /** Validates and stores a value; throws {@link InvalidSettingError}. */
  set<K extends SettingKey>(key: K, value: unknown, updatedBy: string | null): SettingValue<K>;
}

export function createSettingsServiceWith(repository: SettingsRepository, clock: Clock, logger: Logger): SettingsService {
  return {
    get<K extends SettingKey>(key: K): SettingValue<K> {
      const entry = settingsRegistry[key];
      const row = repository.find(key);
      if (row === undefined) return structuredClone(entry.default);
      let stored: unknown;
      try {
        stored = JSON.parse(row.value);
      } catch {
        logger.warn({ setting: key }, "Stored setting is not valid JSON; using the default");
        return structuredClone(entry.default);
      }
      const result = entry.schema.safeParse(stored);
      if (!result.success) {
        logger.warn(
          { setting: key, issues: result.error.issues.map((issue) => issue.message) },
          "Stored setting no longer validates; using the default",
        );
        return structuredClone(entry.default);
      }
      return result.data;
    },

    set<K extends SettingKey>(key: K, value: unknown, updatedBy: string | null): SettingValue<K> {
      const result = settingsRegistry[key].schema.safeParse(value);
      if (!result.success) {
        throw new InvalidSettingError(
          key,
          result.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`),
        );
      }
      repository.upsert({
        key,
        value: JSON.stringify(result.data),
        updatedAt: clock.now().toISOString(),
        updatedBy,
      });
      return result.data;
    },
  };
}
