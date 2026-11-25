import { isDeepStrictEqual } from "node:util";
import type { SecuritySettings } from "@not-unreachable/contracts";
import type { AuditActor, AuditOrigin, AuditService } from "../audit/index.ts";
import type { SettingsService } from "../settings/index.ts";

/** The settings the Security tab holds, each one a key of the settings registry. */
export const securitySettingKeys = ["sessionTimeouts", "signInLimits", "auditRetentionDays"] as const;

export interface SecuritySettingsService {
  read(): SecuritySettings;
  /** Stores the values and records `settings.changed` with the keys whose values changed (never the values). */
  update(values: SecuritySettings, actor: Extract<AuditActor, { kind: "account" }>, origin: AuditOrigin): SecuritySettings;
}

export function createSecuritySettingsService(settings: SettingsService, audit: AuditService): SecuritySettingsService {
  const read = (): SecuritySettings => ({
    sessionTimeouts: settings.get("sessionTimeouts"),
    signInLimits: settings.get("signInLimits"),
    auditRetentionDays: settings.get("auditRetentionDays"),
  });

  return {
    read,
    update(values, actor, origin) {
      const current = read();
      const changed = securitySettingKeys.filter((key) => !isDeepStrictEqual(current[key], values[key]));
      for (const key of changed) settings.set(key, values[key], actor.accountId);
      if (changed.length > 0) {
        audit.record({ action: "settings.changed", actor, outcome: "succeeded", origin, details: { keys: [...changed] } });
      }
      return read();
    },
  };
}
