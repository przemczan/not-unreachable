import type { Clock, Db, Logger } from "../platform/index.ts";
import { createSettingsRepository } from "./repository.ts";
import { createSettingsServiceWith, type SettingsService } from "./service.ts";

export { settingsRegistry, type SettingDefinition, type SettingKey, type SettingValue } from "./registry.ts";
export { InvalidSettingError, type SettingsService } from "./service.ts";

export interface SettingsDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function createSettingsService({ db, clock, logger }: SettingsDependencies): SettingsService {
  return createSettingsServiceWith(createSettingsRepository(db), clock, logger);
}
