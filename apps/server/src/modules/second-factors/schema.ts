import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "../accounts/index.ts";

/**
 * Authenticator apps (threat model, T10). The secret is a `secrets` envelope (purpose `totp`, AAD
 * `totp_credentials:secret:<id>`) that `rotate-key` re-encrypts. A row counts as a factor only once
 * confirmed; unconfirmed rows are deleted after 10 minutes.
 */
export const totpCredentials = sqliteTable(
  "totp_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    /** The last 30-second step a code was accepted for; no code of it or an earlier step passes again. */
    lastUsedStep: integer("last_used_step"),
    createdAt: text("created_at").notNull(),
    confirmedAt: text("confirmed_at"),
    lastUsedAt: text("last_used_at"),
    /**
     * The session that started the enrolment: only it may confirm it, and at sign-in only it may
     * acknowledge the recovery codes it got. No foreign key: sessions sit beside this module.
     */
    enrolmentSessionId: text("enrolment_session_id"),
  },
  (table) => [index("totp_credentials_user_idx").on(table.userId)],
);

export type TotpCredentialRow = typeof totpCredentials.$inferSelect;

/** Single-use stand-ins for a second factor, argon2id-hashed; a batch replaces the one before it. */
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    batchId: text("batch_id").notNull(),
    codeHash: text("code_hash").notNull(),
    createdAt: text("created_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [index("recovery_codes_user_idx").on(table.userId)],
);

export type RecoveryCodeRow = typeof recoveryCodes.$inferSelect;

/** Wrong second-factor codes, counted per session and per account for the try limits (T10). */
export const secondFactorFailures = sqliteTable(
  "second_factor_failures",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    at: text("at").notNull(),
  },
  (table) => [index("second_factor_failures_user_idx").on(table.userId, table.at)],
);

export type SecondFactorFailureRow = typeof secondFactorFailures.$inferSelect;

/**
 * Passkeys (threat model, T10): WebAuthn credentials, discoverable, with user verification. Only the
 * public key is kept, so the row is no secret. A passkey counts as a factor from the moment it is saved.
 */
export const passkeyCredentials = sqliteTable(
  "passkey_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The credential id the authenticator chose, base64url. */
    credentialId: text("credential_id").notNull().unique(),
    /** The COSE public key. */
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    /** The signature counter last seen; 0 when the authenticator keeps none. */
    counter: integer("counter").notNull(),
    /** JSON array of the transports the browser reported, for `allowCredentials`. */
    transports: text("transports", { mode: "json" }).$type<string[]>().notNull(),
    /** Whether the passkey is backed up (synced), as its last use reported. */
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    /** The session that added it, so at sign-in only that session acknowledges the recovery codes it got. */
    enrolmentSessionId: text("enrolment_session_id"),
  },
  (table) => [index("passkey_credentials_user_idx").on(table.userId)],
);

export type PasskeyCredentialRow = typeof passkeyCredentials.$inferSelect;

export const webAuthnChallengePurposes = ["register", "second-factor", "passwordless", "confirm"] as const;
export type WebAuthnChallengePurpose = (typeof webAuthnChallengePurposes)[number];

/**
 * WebAuthn challenges, single use and void after 5 minutes (T10). Each is bound to the session that
 * asked for it, or, for passwordless sign-in, to the browser's `__Host-nu_webauthn` cookie, kept as
 * its SHA-256. Sessions sit beside this module, so no foreign key to them.
 */
export const webAuthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose", { enum: webAuthnChallengePurposes }).notNull(),
    /** base64url, as the options carry it. */
    challenge: text("challenge").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    browserTokenHash: text("browser_token_hash"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [
    index("webauthn_challenges_session_idx").on(table.sessionId),
    index("webauthn_challenges_browser_idx").on(table.browserTokenHash),
  ],
);

export type WebAuthnChallengeRow = typeof webAuthnChallenges.$inferSelect;
