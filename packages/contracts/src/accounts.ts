import { z } from "zod";

export const roles = ["admin", "user"] as const;
export type Role = (typeof roles)[number];

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Unique, lowercase, fixed once the account exists: the home folder is named after it (domain.md, Glossary). */
export const usernameSchema = z.string().regex(USERNAME_PATTERN, "Use 3–32 lowercase letters, digits, dots, dashes or underscores.");

export const emailSchema = z.email().max(254);

export const displayNameSchema = z.string().trim().min(1).max(100);

/**
 * A new password's length (threat model, T1); no composition rules. The server also refuses one
 * on its bundled breached-password list.
 */
export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** A password being checked: any length the server would ever have stored, so a too-long one simply fails. */
export const enteredPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

export const TOTP_CODE_DIGITS = 6;

/** A 6-digit authenticator code; spaces are dropped, as apps show `123 456`. */
export const totpCodeSchema = z
  .string()
  .max(16)
  .transform((code) => code.replaceAll(/\s/g, ""))
  .pipe(z.string().regex(/^\d{6}$/, "Enter the 6-digit code."));

export const accountSchema = z.strictObject({
  id: z.uuid(),
  username: usernameSchema,
  /** Always set for the admin; a user has one only when their invitation had one or they added it. */
  email: emailSchema.nullable(),
  displayName: displayNameSchema,
  role: z.enum(roles),
});

export type Account = z.infer<typeof accountSchema>;
