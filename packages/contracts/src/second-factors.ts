import { z } from "zod";
import { totpCodeSchema } from "./accounts.ts";
import { defineRoute } from "./route.ts";
import { sessionSchema } from "./session.ts";

/** How a second factor is passed at sign-in. */
export const secondFactorMethods = ["totp", "passkey", "recoveryCode"] as const;
export type SecondFactorMethod = (typeof secondFactorMethods)[number];

/** The kinds of second factor an account can have; recovery codes stand in for one, they are none. */
export const secondFactorKinds = ["totp", "passkey"] as const;
export type SecondFactorKind = (typeof secondFactorKinds)[number];

export const RECOVERY_CODE_COUNT = 10;
/** Base32 characters (RFC 4648, A–Z and 2–7), 50 bits; shown as two groups of 5. */
export const RECOVERY_CODE_LENGTH = 10;

/** A recovery code as typed: any case, with or without its dash or spaces; the server normalises it. */
export const recoveryCodeSchema = z.string().trim().min(RECOVERY_CODE_LENGTH).max(32);

export const secondFactorStepSchema = z.strictObject({
  /** `enrol` while the account has no confirmed factor: it must add one before it can go on. */
  mode: z.enum(["verify", "enrol"]),
  /** What the account can pass the step with; empty in `enrol` mode. */
  methods: z.array(z.enum(secondFactorMethods)),
});

export type SecondFactorStep = z.infer<typeof secondFactorStepSchema>;

/**
 * An authenticator app being added: the only answer that ever carries its key, once, before it is
 * confirmed. The QR code is an SVG data URL of the `otpauth://` URI.
 */
export const totpEnrolmentSchema = z.strictObject({
  id: z.uuid(),
  /** The key in base32, for apps that can't scan the QR code. */
  setupKey: z.string(),
  qrCode: z.string().startsWith("data:image/svg+xml;base64,"),
});

export type TotpEnrolment = z.infer<typeof totpEnrolmentSchema>;

export const recoveryCodesSchema = z.strictObject({
  /** Shown once; the server keeps only their argon2id hashes. */
  recoveryCodes: z.array(z.string()).length(RECOVERY_CODE_COUNT),
});

export type RecoveryCodes = z.infer<typeof recoveryCodesSchema>;

export const totpCodeBodySchema = z.strictObject({ code: totpCodeSchema });

const enrolmentParams = z.strictObject({ id: z.uuid() });

/** One second factor, as Settings → Two-step sign-in lists it. Never its secret; a passkey's name and more are in `passkeys.ts`. */
export const secondFactorSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(secondFactorKinds),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

export type SecondFactor = z.infer<typeof secondFactorSchema>;

export const secondFactorsSchema = z.strictObject({
  /** Confirmed factors, oldest first. */
  factors: z.array(secondFactorSchema),
  /** The current set of recovery codes; null before the first factor. */
  recoveryCodes: z
    .strictObject({
      remaining: z.int().min(0).max(RECOVERY_CODE_COUNT),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
});

export type SecondFactors = z.infer<typeof secondFactorsSchema>;

/*
 * The sign-in step after the password. The session is `pendingSecondFactor` for these routes; an
 * active session gets 403. Passing a factor, or acknowledging the recovery codes after enrolment,
 * makes the session active with a new token (threat model, T2 and T10).
 */

export const getSecondFactorStepRoute = defineRoute({
  method: "GET",
  path: "/api/v1/sign-in/second-factor",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: true,
  responses: { 200: secondFactorStepSchema },
});

export const passTotpRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/totp",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  body: totpCodeBodySchema,
  responses: { 200: sessionSchema },
});

export const passRecoveryCodeRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/recovery-code",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  body: z.strictObject({ code: recoveryCodeSchema }),
  responses: { 200: sessionSchema },
});

/** Refused (409) once the account has a confirmed factor, so a password alone can't add one. */
export const startTotpEnrolmentRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/enrol/totp",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  responses: { 200: totpEnrolmentSchema },
});

/** Confirms the enrolment this session started and answers the first recovery codes. */
export const confirmTotpEnrolmentRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/enrol/totp/confirm",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  body: totpCodeBodySchema.extend({ id: z.uuid() }),
  responses: { 200: recoveryCodesSchema },
});

/** Only the session that confirmed the enrolment may; it then becomes active. */
export const acknowledgeRecoveryCodesRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sign-in/second-factor/enrol/recovery-codes/acknowledge",
  access: "pendingSecondFactor",
  recentSignIn: false,
  safe: false,
  responses: { 200: sessionSchema },
});

/* Settings → Two-step sign-in (the admin). */

export const getSecondFactorsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/settings/second-factors",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: secondFactorsSchema },
});

/** Starts adding another authenticator app; it counts once confirmed. */
export const addTotpRoute = defineRoute({
  method: "POST",
  path: "/api/v1/settings/second-factors/totp",
  access: "admin",
  recentSignIn: true,
  safe: false,
  responses: { 200: totpEnrolmentSchema },
});

export const confirmTotpRoute = defineRoute({
  method: "POST",
  path: "/api/v1/settings/second-factors/totp/:id/confirm",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: enrolmentParams,
  body: totpCodeBodySchema,
  responses: { 200: secondFactorSchema },
});

/** Refused (409 `last-second-factor`) for the account's last factor, authenticator app or passkey. */
export const removeTotpRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/settings/second-factors/totp/:id",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: enrolmentParams,
  responses: { 204: z.undefined() },
});

/** Voids every earlier recovery code and answers the new set. */
export const regenerateRecoveryCodesRoute = defineRoute({
  method: "POST",
  path: "/api/v1/settings/second-factors/recovery-codes",
  access: "admin",
  recentSignIn: true,
  safe: false,
  responses: { 200: recoveryCodesSchema },
});
