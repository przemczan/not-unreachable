import { z } from "zod";
import { defineRoute } from "./route.ts";
import { recoveryCodesSchema } from "./second-factors.ts";
import { sessionSchema } from "./session.ts";
import {
  passkeyAuthenticationResponseSchema,
  passkeyCreationOptionsSchema,
  passkeyRegistrationResponseSchema,
  passkeyRequestOptionsSchema,
} from "./webauthn.ts";

export const PASSKEY_NAME_MAX_CHARACTERS = 64;

/** What the admin calls a passkey, such as "Phone" or "YubiKey". */
export const passkeyNameSchema = z.string().trim().min(1).max(PASSKEY_NAME_MAX_CHARACTERS);

/** One passkey, as Settings → Two-step sign-in lists it. Never its public key or credential id. */
export const passkeySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** Whether the passkey is backed up, such as by a password manager or a phone's cloud keychain. */
  synced: z.boolean(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

export type Passkey = z.infer<typeof passkeySchema>;

export const passkeysSchema = z.strictObject({
  /** Oldest first. */
  passkeys: z.array(passkeySchema),
});

export const newPasskeySchema = z.strictObject({
  name: passkeyNameSchema,
  response: passkeyRegistrationResponseSchema,
});

export type NewPasskey = z.infer<typeof newPasskeySchema>;

export const addedPasskeySchema = z.strictObject({
  passkey: passkeySchema,
  /** The account's first recovery codes, shown once, when it had none yet; null otherwise. */
  recoveryCodes: recoveryCodesSchema.shape.recoveryCodes.nullable(),
});

export type AddedPasskey = z.infer<typeof addedPasskeySchema>;

export const passkeyAssertionBodySchema = z.strictObject({ response: passkeyAuthenticationResponseSchema });

const passkeyParams = z.strictObject({ id: z.uuid() });

/*
 * Every ceremony starts with an options route that issues a challenge, single use and void after 5
 * minutes (threat model, T10), bound to the session, or for passwordless sign-in to the
 * `__Host-nu_webauthn` cookie. Starting again voids the one before.
 */

/* Settings → Two-step sign-in (the admin). */

export const listPasskeysRoute = defineRoute({
  method: "GET",
  path: "/api/v1/settings/passkeys",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: passkeysSchema },
});

export const startPasskeyRegistrationRoute = defineRoute({
  method: "POST",
  path: "/api/v1/settings/passkeys/registration-options",
  access: "admin",
  recentSignIn: true,
  safe: false,
  responses: { 200: passkeyCreationOptionsSchema },
});

/** Verifies the attestation against the session's challenge (422 `secondFactorFailed` when it doesn't pass) and saves the passkey. */
export const addPasskeyRoute = defineRoute({
  method: "POST",
  path: "/api/v1/settings/passkeys",
  access: "admin",
  recentSignIn: true,
  safe: false,
  body: newPasskeySchema,
  responses: { 200: addedPasskeySchema },
});

export const renamePasskeyRoute = defineRoute({
  method: "PATCH",
  path: "/api/v1/settings/passkeys/:id",
  access: "admin",
  recentSignIn: false,
  safe: false,
  params: passkeyParams,
  body: z.strictObject({ name: passkeyNameSchema }),
  responses: { 200: passkeySchema },
});

/** Refused (409 `last-second-factor`) for the account's last factor. */
export const removePasskeyRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/settings/passkeys/:id",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: passkeyParams,
  responses: { 204: z.undefined() },
});

/* The second-factor step of a pending session. */

export const startPasskeySecondFactorRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/passkey/options",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  responses: { 200: passkeyRequestOptionsSchema },
});

/** Like a wrong code: 401 `secondFactorFailed`, counted against the try limits. */
export const passPasskeyRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/passkey/verify",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  body: passkeyAssertionBodySchema,
  responses: { 200: sessionSchema },
});

/** Enrol mode: refused (409) once the account has a confirmed factor, like the authenticator app's. */
export const startPasskeyEnrolmentRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/enrol/passkey/options",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  responses: { 200: passkeyCreationOptionsSchema },
});

/** Saves the session's new passkey and answers the first recovery codes; acknowledging them makes the session active. */
export const confirmPasskeyEnrolmentRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/enrol/passkey",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  body: newPasskeySchema,
  responses: { 200: recoveryCodesSchema },
});

/* Passwordless sign-in: a passkey with user verification counts as both steps. */

/** Sets the `__Host-nu_webauthn` cookie the challenge is bound to. */
export const startPasskeySignInRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/passkey/options",
  access: "public",
  recentSignIn: false,
  safe: false,
  responses: { 200: passkeyRequestOptionsSchema },
});

/** Every failure is the same 401 `signInFailed` as a failed password sign-in, under the same per-IP limits. */
export const passkeySignInRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/passkey/verify",
  access: "public",
  recentSignIn: false,
  safe: false,
  body: passkeyAssertionBodySchema,
  responses: { 200: sessionSchema },
});

/** The challenge for renewing the recent sign-in with a passkey (`POST /api/v1/session/confirm`). */
export const startPasskeyConfirmationRoute = defineRoute({
  method: "POST",
  path: "/api/v1/session/confirm/passkey-options",
  access: "account",
  recentSignIn: false,
  safe: false,
  responses: { 200: passkeyRequestOptionsSchema },
});
