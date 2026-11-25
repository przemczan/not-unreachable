import { z } from "zod";
import { displayNameSchema, emailSchema, newPasswordSchema, usernameSchema } from "./accounts.ts";
import { defineRoute } from "./route.ts";

/** A setup token: 32 random bytes, base64url (deployment.md, First admin). */
export const setupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const setupStatusSchema = z.strictObject({
  /** Once true, /setup only sets a new password for the admin, with a link from `reset-admin`. */
  adminExists: z.boolean(),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** First run: creates the admin. */
export const firstRunSetupSchema = z.strictObject({
  token: setupTokenSchema,
  username: usernameSchema,
  email: emailSchema,
  displayName: displayNameSchema,
  password: newPasswordSchema,
});

/** After `reset-admin`: sets a new password for the existing admin. */
export const adminResetSetupSchema = z.strictObject({
  token: setupTokenSchema,
  password: newPasswordSchema,
});

export const setupRequestSchema = z.union([firstRunSetupSchema, adminResetSetupSchema]);

export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const setupResultSchema = z.strictObject({ username: usernameSchema });

export const setupStatusRoute = defineRoute({
  method: "GET",
  path: "/api/v1/setup/status",
  access: "public",
  recentSignIn: false,
  safe: true,
  responses: { 200: setupStatusSchema },
});

/** Answers 404 unless the token is a valid, unused setup token for the instance's state. */
export const setupRoute = defineRoute({
  method: "POST",
  path: "/api/v1/setup",
  access: "public",
  recentSignIn: false,
  safe: false,
  body: setupRequestSchema,
  responses: { 200: setupResultSchema },
});
