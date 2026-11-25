import { routes, secondFactorMethods, securitySettingsSchema, type RouteContract } from "@not-unreachable/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { settingsRegistry } from "../settings/index.ts";

const table: [string, RouteContract][] = Object.entries(routes);

/** The keys a body schema takes, through unions and their options. */
function bodyKeys(schema: z.core.$ZodType | undefined): string[] {
  if (schema === undefined) return [];
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((option) => bodyKeys(option));
  return [];
}

/** Anything that would let a code sent by email, or any other one-time link, stand in for a sign-in. */
const emailCodeWords = /e-?mail-?(code|otp|token|link)|magic|one-?time|\botp\b|verification-?code/i;

/** Threat model T1, T9 and T10: how anyone can sign in, read off the contracts. */
describe("the sign-in methods", () => {
  it("are a password (the admin's), a passkey, an SSO provider, the first-run setup and an invitation or re-link link", () => {
    const publicWrites = table
      .filter(([, route]) => route.access === "public" && route.method !== "GET" && route.method !== "HEAD")
      .map(([name]) => name)
      .toSorted();
    expect(publicWrites).toEqual(
      [
        "setup",
        "signIn",
        "startPasskeySignIn",
        "passkeySignIn",
        "startSsoSignIn",
        "acceptInvitation",
        "startRelink",
        "unlockShareLink",
      ].toSorted(),
    );
  });

  it("take a password outside the admin's routes on these only, none of which signs a user in", () => {
    // The admin's own routes (password change, SMB, SMTP, share links) are out of a user's reach.
    const takesPassword = table
      .filter(([, route]) => route.access !== "admin")
      .filter(([, route]) => bodyKeys(route.body).some((key) => /password/i.test(key)))
      .map(([name, route]) => [name, route.access]);
    expect(Object.fromEntries(takesPassword)).toEqual({
      // The admin's: first run, or after reset-admin.
      setup: "public",
      // Refused for any account but the admin's (sign-in.test.ts).
      signIn: "public",
      confirmSession: "account",
      // A share link's own password, not an account's.
      unlockShareLink: "public",
    });
  });

  it("have no email codes: no such route, second-factor method or setting", () => {
    for (const [name, route] of table) {
      expect(`${name} ${route.path} ${bodyKeys(route.body).join(" ")}`).not.toMatch(emailCodeWords);
    }
    expect([...secondFactorMethods]).toEqual(["totp", "passkey", "recoveryCode"]);
    for (const key of Object.keys(settingsRegistry)) expect(key).not.toMatch(/mail|code|secondFactor|twoFactor|mfa|otp/i);
    // Nor any setting that turns the admin's second factor off (T10).
    expect(Object.keys(securitySettingsSchema.shape).toSorted()).toEqual(["auditRetentionDays", "sessionTimeouts", "signInLimits"]);
  });
});
