import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "../accounts/index.ts";

// A literal, not the contracts' array: drizzle-kit loads this file without the contracts package.
// repository.ts checks it equals the contracts' `ssoProviderKinds`.
export const storedProviderKinds = ["google", "github", "oidc"] as const;

/**
 * The SSO providers the admin added. The client secret is a `secrets` envelope (purpose `sso`, AAD
 * `sso_providers:client_secret:<id>`) that `rotate-key` re-encrypts (threat model, T6).
 */
export const ssoProviders = sqliteTable("sso_providers", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: storedProviderKinds }).notNull(),
  name: text("name").notNull(),
  /** Fixed for Google and GitHub; a generic OIDC provider's, as its discovery document states it. */
  issuer: text("issuer").notNull().unique(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type SsoProviderRow = typeof ssoProviders.$inferSelect;

/**
 * An identity at a provider that signs in as an account (threat model, T9): matched by (issuer,
 * subject) only, never by email. A provider with links can't be removed, only disabled.
 */
export const linkedSignIns = sqliteTable(
  "linked_sign_ins",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => ssoProviders.id, { onDelete: "restrict" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    /** What the provider reported when the link was made: display only. */
    emailAtLink: text("email_at_link"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    uniqueIndex("linked_sign_ins_identity_idx").on(table.issuer, table.subject),
    index("linked_sign_ins_user_idx").on(table.userId),
  ],
);

export type LinkedSignInRow = typeof linkedSignIns.$inferSelect;

/**
 * A started SSO flow, single use, for 10 minutes (threat model, T3 and T9). It is bound to the
 * browser by the `__Host-nu_sso` cookie, stored only as its SHA-256; the PKCE verifier is an
 * envelope (AAD `sso_flows:code_verifier:<id>`). A link flow carries the account and session that
 * started it, as the Strict session cookie doesn't come back with the provider's redirect; a purpose
 * may carry its own JSON in `purpose_data` (accepting an invitation keeps the invitation and the
 * chosen username there). It never holds a secret.
 */
export const ssoFlows = sqliteTable(
  "sso_flows",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => ssoProviders.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    bindingHash: text("binding_hash").notNull().unique(),
    state: text("state").notNull(),
    nonce: text("nonce"),
    codeVerifier: text("code_verifier").notNull(),
    accountId: text("account_id"),
    sessionId: text("session_id"),
    purposeData: text("purpose_data"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("sso_flows_expires_idx").on(table.expiresAt)],
);

export type SsoFlowRow = typeof ssoFlows.$inferSelect;
