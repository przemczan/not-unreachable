import { z } from "zod";
import { accountSchema, displayNameSchema, emailSchema, enteredPasswordSchema, newPasswordSchema } from "./accounts.ts";
import { defineRoute } from "./route.ts";

export const profileSchema = accountSchema;

export type Profile = z.infer<typeof profileSchema>;

/** A change of email needs a recent sign-in; the display name doesn't. */
export const profileChangeSchema = z
  .strictObject({ email: emailSchema.optional(), displayName: displayNameSchema.optional() })
  .refine((change) => change.email !== undefined || change.displayName !== undefined, "Change at least one field.");

export const passwordChangeSchema = z.strictObject({
  currentPassword: enteredPasswordSchema,
  newPassword: newPasswordSchema,
});

/** One signed-in browser, as Settings → Sessions lists it. */
export const sessionSummarySchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** The session making this request. */
  current: z.boolean(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const getProfileRoute = defineRoute({
  method: "GET",
  path: "/api/v1/settings/profile",
  access: "account",
  recentSignIn: false,
  safe: true,
  responses: { 200: profileSchema },
});

/** Answers `recent-sign-in-required` when the email changes without a recent sign-in. */
export const updateProfileRoute = defineRoute({
  method: "PATCH",
  path: "/api/v1/settings/profile",
  access: "account",
  recentSignIn: false,
  safe: false,
  body: profileChangeSchema,
  responses: { 200: profileSchema },
});

/** Only the admin has a password. Signs out every other session and rotates this one. */
export const changePasswordRoute = defineRoute({
  method: "PUT",
  path: "/api/v1/settings/password",
  access: "admin",
  recentSignIn: true,
  safe: false,
  body: passwordChangeSchema,
  responses: { 204: z.undefined() },
});

export const listSessionsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/settings/sessions",
  access: "account",
  recentSignIn: false,
  safe: true,
  responses: { 200: z.strictObject({ sessions: z.array(sessionSummarySchema) }) },
});

export const revokeSessionRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/settings/sessions/:id",
  access: "account",
  recentSignIn: false,
  safe: false,
  params: z.strictObject({ id: z.uuid() }),
  responses: { 204: z.undefined() },
});

/** Signs out every session of the account but this one. */
export const revokeOtherSessionsRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/settings/sessions",
  access: "account",
  recentSignIn: false,
  safe: false,
  responses: { 200: z.strictObject({ revoked: z.int().min(0) }) },
});
