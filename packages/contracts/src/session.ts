import { z } from "zod";
import { accountSchema, enteredPasswordSchema, totpCodeSchema } from "./accounts.ts";
import { defineRoute } from "./route.ts";
import { passkeyAuthenticationResponseSchema } from "./webauthn.ts";

export const sessionStates = ["pendingSecondFactor", "active"] as const;
export type SessionState = (typeof sessionStates)[number];

/** The caller's own session: who is signed in, and how. */
export const sessionSchema = z.strictObject({
  account: accountSchema,
  state: z.enum(sessionStates),
  /** When the recent sign-in lapses; null when the session has none. */
  recentSignInUntil: z.iso.datetime().nullable(),
});

export type Session = z.infer<typeof sessionSchema>;

export const signInRequestSchema = z.strictObject({
  /** A username or an email. */
  identifier: z.string().trim().min(1).max(254),
  password: enteredPasswordSchema,
});

export const signInRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in",
  access: "public",
  recentSignIn: false,
  safe: false,
  body: signInRequestSchema,
  responses: { 200: sessionSchema },
});

/** Open to a session still pending its second factor, so it can always sign out. */
export const signOutRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-out",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  responses: { 204: z.undefined() },
});

export const getSessionRoute = defineRoute({
  method: "GET",
  path: "/api/v1/session",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: true,
  responses: { 200: sessionSchema },
});

/**
 * The password, a code from one of the account's authenticator apps, or an assertion of one of its
 * passkeys over the challenge from `POST /api/v1/session/confirm/passkey-options`.
 */
export const sessionConfirmationSchema = z.union([
  z.strictObject({ password: enteredPasswordSchema }),
  z.strictObject({ code: totpCodeSchema }),
  z.strictObject({ passkey: passkeyAuthenticationResponseSchema }),
]);

export type SessionConfirmation = z.input<typeof sessionConfirmationSchema>;

/** Renews the recent sign-in by proving the password or a second factor again; the session's token rotates. */
export const confirmSessionRoute = defineRoute({
  method: "POST",
  path: "/api/v1/session/confirm",
  access: "account",
  recentSignIn: false,
  safe: false,
  body: sessionConfirmationSchema,
  responses: { 200: sessionSchema },
});
