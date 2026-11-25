import { auditRetentionDaysSchema, sessionTimeoutsSchema, signInLimitsSchema, uploadLimitsSchema } from "@not-unreachable/contracts";
import { z } from "zod";

export interface SettingDefinition<T> {
  readonly schema: z.ZodType<T>;
  readonly default: T;
}

function defineSetting<T>(schema: z.ZodType<T>, defaultValue: NoInfer<T>): SettingDefinition<T> {
  return { schema, default: schema.parse(defaultValue) };
}

const definitions = {
  /** Requests per IP across the whole API (threat model, T11). */
  globalRateLimit: defineSetting(
    z.strictObject({
      max: z.int().min(1).max(100_000),
      timeWindowSeconds: z.int().min(1).max(86_400),
    }),
    { max: 600, timeWindowSeconds: 60 },
  ),
  /** Requests per IP to the public invitation and re-link routes (threat model, T11). */
  linkPageRateLimit: defineSetting(
    z.strictObject({
      max: z.int().min(1).max(100_000),
      timeWindowSeconds: z.int().min(1).max(86_400),
    }),
    { max: 20, timeWindowSeconds: 60 },
  ),
  /** The public share API's limits (threat model, T8 and T11); their windows are fixed, as the names say. */
  shareLinkLimits: defineSetting(
    z.strictObject({
      invalidTokensPerIpPerMinute: z.int().min(1).max(100_000),
      invalidTokenBlockMinutes: z.int().min(1).max(1_440),
      wrongPasswordsPerIpPer15Minutes: z.int().min(1).max(1_000),
      wrongPasswordsPerLinkPerHour: z.int().min(1).max(100_000),
      lockMinutes: z.int().min(1).max(1_440),
      concurrentDownloadsPerIp: z.int().min(1).max(100),
    }),
    {
      invalidTokensPerIpPerMinute: 20,
      invalidTokenBlockMinutes: 15,
      wrongPasswordsPerIpPer15Minutes: 5,
      wrongPasswordsPerLinkPerHour: 50,
      lockMinutes: 60,
      concurrentDownloadsPerIp: 4,
    },
  ),
  /** Idle and absolute session timeouts per role (threat model, T2). */
  sessionTimeouts: defineSetting(sessionTimeoutsSchema, {
    admin: { idleMinutes: 30, absoluteHours: 12 },
    user: { idleMinutes: 120, absoluteHours: 168 },
  }),
  /** Sign-in limits per IP and per account (threat model, T11). */
  signInLimits: defineSetting(signInLimitsSchema, {
    perIpPerMinute: 10,
    perIpPerHour: 50,
    delayAfterFailures: 5,
    lockAfterFailures: 20,
    lockMinutes: 15,
  }),
  /** How long the audit log keeps events (threat model, T12). */
  auditRetentionDays: defineSetting(auditRetentionDaysSchema, 365),
  /** The quota of a user whose own `quota_bytes` is null: 10 GiB. */
  defaultQuotaBytes: defineSetting(z.int().min(0).max(Number.MAX_SAFE_INTEGER), 10 * 1024 ** 3),
  /** The size limit per file, the disk reserve and the limits on uploads in progress (threat model, T7). */
  uploadLimits: defineSetting(uploadLimitsSchema, {
    maxFileBytes: 50 * 1024 ** 3,
    diskReserve: { percent: 5, bytes: 5 * 1024 ** 3 },
    inProgressPerAccount: 4,
    inProgressPerInstance: 100,
    createdPerAccountPerHour: 20,
  }),
};

export type SettingKey = keyof typeof definitions;

type SettingValues = {
  [K in SettingKey]: (typeof definitions)[K] extends SettingDefinition<infer T> ? T : never;
};

export type SettingValue<K extends SettingKey> = SettingValues[K];

/** Every instance setting: its schema and its default. */
export const settingsRegistry: { readonly [K in SettingKey]: SettingDefinition<SettingValues[K]> } = definitions;
