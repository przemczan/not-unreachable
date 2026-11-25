import { z } from "zod";
import { defineRoute } from "./route.ts";

const sessionTimeoutSchema = z.strictObject({
  /** Signed out after this long without a request; at least 5 minutes (threat model, T2). */
  idleMinutes: z.int().min(5).max(1440),
  /** Signed out this long after sign-in, whatever the activity. */
  absoluteHours: z.int().min(1).max(720),
});

/** Session timeouts per role (T2). */
export const sessionTimeoutsSchema = z.strictObject({
  admin: sessionTimeoutSchema,
  user: sessionTimeoutSchema,
});

export type SessionTimeouts = z.infer<typeof sessionTimeoutsSchema>;

/** Sign-in limits (threat model, T11). The per-account delay doubles from 1 s up to 60 s. */
export const signInLimitsSchema = z.strictObject({
  /** Sign-in attempts per IP (IPv6 by /64) per minute. */
  perIpPerMinute: z.int().min(1).max(1000),
  /** Sign-in attempts per IP (IPv6 by /64) per hour. */
  perIpPerHour: z.int().min(1).max(10_000),
  /** Failures from one IP for one account before each further attempt is delayed. */
  delayAfterFailures: z.int().min(1).max(100),
  /** Failures for one account in an hour, from any IP, that lock it. */
  lockAfterFailures: z.int().min(2).max(1000),
  /** How long a lock lasts; no lock is permanent. */
  lockMinutes: z.int().min(1).max(1440),
});

export type SignInLimits = z.infer<typeof signInLimitsSchema>;

/** How long the audit log keeps events (T12). */
export const auditRetentionDaysSchema = z.int().min(30).max(3650);

/** The Security tab of the Admin settings page. */
export const securitySettingsSchema = z.strictObject({
  sessionTimeouts: sessionTimeoutsSchema,
  signInLimits: signInLimitsSchema,
  auditRetentionDays: auditRetentionDaysSchema,
});

export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const getSecuritySettingsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/settings/security",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: securitySettingsSchema },
});

export const updateSecuritySettingsRoute = defineRoute({
  method: "PUT",
  path: "/api/v1/admin/settings/security",
  access: "admin",
  recentSignIn: true,
  safe: false,
  body: securitySettingsSchema,
  responses: { 200: securitySettingsSchema },
});
