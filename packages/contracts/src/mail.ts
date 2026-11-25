import { z } from "zod";
import { emailSchema } from "./accounts.ts";
import { defineRoute } from "./route.ts";

/**
 * How the SMTP connection is secured (stack.md, "Email: nodemailer over SMTP"): `starttls` upgrades
 * a plain connection and refuses to go on without TLS, `tls` connects over TLS from the start.
 * `none` is allowed only for a loopback host (threat model, T6).
 */
export const smtpTlsModes = ["starttls", "tls", "none"] as const;
export type SmtpTlsMode = (typeof smtpTlsModes)[number];

const smtpHostSchema = z.string().trim().min(1).max(253);
const smtpPortSchema = z.int().min(1).max(65_535);
const smtpUsernameSchema = z.string().trim().min(1).max(500);
/** Write-only: no answer ever carries it (threat model, T6). */
export const smtpPasswordSchema = z.string().min(1).max(2000);

/** The Email tab, once SMTP is set up; never the password. */
export const smtpSettingsSchema = z.strictObject({
  host: z.string(),
  port: smtpPortSchema,
  tlsMode: z.enum(smtpTlsModes),
  username: z.string().nullable(),
  passwordSet: z.boolean(),
  fromAddress: z.string(),
  updatedAt: z.iso.datetime(),
});

export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

export const mailSettingsSchema = z.strictObject({
  /** Null until the admin sets SMTP up: nothing is emailed then. */
  smtp: smtpSettingsSchema.nullable(),
});

export type MailSettings = z.infer<typeof mailSettingsSchema>;

/**
 * Replaces the SMTP settings. A left-out `password` keeps the stored one; a null `username` signs
 * in with none (and drops the password). `tlsMode: "none"` with a host that isn't loopback is
 * refused (422 `validation-failed`).
 */
export const updateMailSettingsRequestSchema = z.strictObject({
  host: smtpHostSchema,
  port: smtpPortSchema,
  tlsMode: z.enum(smtpTlsModes),
  username: smtpUsernameSchema.nullable(),
  password: smtpPasswordSchema.optional(),
  fromAddress: emailSchema,
});

export type UpdateMailSettingsRequest = z.input<typeof updateMailSettingsRequestSchema>;

export const testEmailSentSchema = z.strictObject({ sentTo: z.string() });

export type TestEmailSent = z.infer<typeof testEmailSentSchema>;

export const getMailSettingsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/mail",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: mailSettingsSchema },
});

export const updateMailSettingsRoute = defineRoute({
  method: "PUT",
  path: "/api/v1/admin/mail",
  access: "admin",
  recentSignIn: true,
  safe: false,
  body: updateMailSettingsRequestSchema,
  responses: { 200: mailSettingsSchema },
});

/** Sends a test email to the admin's own address (409 `smtp-not-configured`, 502 `mail-send-failed`). */
export const sendTestEmailRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/mail/test",
  access: "admin",
  recentSignIn: false,
  safe: false,
  responses: { 200: testEmailSentSchema },
});
