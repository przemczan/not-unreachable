import { z } from "zod";
import { defineRoute } from "./route.ts";

/**
 * The kinds of SSO provider (domain.md, Glossary). Google and GitHub have fixed issuers; a
 * generic OIDC provider is found by discovery from the issuer the admin enters.
 */
export const ssoProviderKinds = ["google", "github", "oidc"] as const;
export type SsoProviderKind = (typeof ssoProviderKinds)[number];

export const GOOGLE_ISSUER = "https://accounts.google.com";
/** GitHub is OAuth 2, not OIDC: this constant stands in for an issuer, with the numeric user id as the subject (stack.md). */
export const GITHUB_ISSUER = "https://github.com";

/** The issuer each kind with a fixed one always has. */
export const fixedIssuers = { google: GOOGLE_ISSUER, github: GITHUB_ISSUER } as const satisfies Partial<Record<SsoProviderKind, string>>;

export const SSO_PROVIDER_NAME_MAX_CHARACTERS = 60;

export const ssoProviderNameSchema = z.string().trim().min(1).max(SSO_PROVIDER_NAME_MAX_CHARACTERS);

/** A generic OIDC issuer: `https://` only (threat model, T15), without a query or fragment. */
export const ssoIssuerSchema = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine((issuer) => !/[?#]/.test(issuer), "The issuer can't have a query or fragment.");

export const ssoClientIdSchema = z.string().trim().min(1).max(500);
/** Write-only: no answer ever carries it (threat model, T6). */
export const ssoClientSecretSchema = z.string().trim().min(1).max(2000);

/** A provider as the admin's Sign-in providers tab shows it; never its client secret. */
export const ssoProviderSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(ssoProviderKinds),
  name: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  clientSecretSet: z.boolean(),
  enabled: z.boolean(),
  /** Where the provider sends the browser back: always `PUBLIC_ORIGIN + /api/v1/sso/<id>/callback`. */
  redirectUri: z.url(),
  /** How many linked sign-ins use it; a provider with any can only be disabled, not removed. */
  linkedSignIns: z.int().min(0),
  createdAt: z.iso.datetime(),
});

export type SsoProvider = z.infer<typeof ssoProviderSchema>;

export const ssoProvidersSchema = z.strictObject({
  providers: z.array(ssoProviderSchema),
  /** `PUBLIC_ORIGIN`, so the admin's tab can show a new provider's redirect URI before it is added. */
  publicOrigin: z.url(),
});

/** Where a provider sends the browser back, on `PUBLIC_ORIGIN`. */
export const ssoCallbackPath = (providerId: string): string => `/api/v1/sso/${providerId}/callback`;

const newProviderFields = {
  /**
   * The id the provider is added with, a lower-case UUIDv7 as every id the server makes, so its
   * redirect URI can be registered at the provider before it is added. Taken already: 409
   * `sso-provider-id-taken`. Left out, the server makes one.
   */
  id: z.uuidv7().lowercase().optional(),
  name: ssoProviderNameSchema,
  clientId: ssoClientIdSchema,
  clientSecret: ssoClientSecretSchema,
  enabled: z.boolean().default(true),
};

export const addSsoProviderRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("google"), ...newProviderFields }),
  z.strictObject({ kind: z.literal("github"), ...newProviderFields }),
  z.strictObject({ kind: z.literal("oidc"), issuer: ssoIssuerSchema, ...newProviderFields }),
]);

export type AddSsoProviderRequest = z.input<typeof addSsoProviderRequestSchema>;

/**
 * Only the fields given change; the kind is fixed once added. A left-out `clientSecret` keeps the
 * stored one. `issuer` is for generic OIDC providers only (422 otherwise), and can't change while
 * linked sign-ins use the provider (409 `sso-provider-in-use`): they match on it.
 */
export const changeSsoProviderRequestSchema = z
  .strictObject({
    name: ssoProviderNameSchema.optional(),
    issuer: ssoIssuerSchema.optional(),
    clientId: ssoClientIdSchema.optional(),
    clientSecret: ssoClientSecretSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((change) => Object.values(change).some((value) => value !== undefined), "Change at least one field.");

export type ChangeSsoProviderRequest = z.input<typeof changeSsoProviderRequestSchema>;

const providerParams = z.strictObject({ id: z.uuid() });

/** An enabled provider, as the sign-in page and Settings → Linked sign-ins offer it. */
export const signInProviderSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(ssoProviderKinds),
  name: z.string(),
});

export type SignInProvider = z.infer<typeof signInProviderSchema>;

export const signInProvidersSchema = z.strictObject({ providers: z.array(signInProviderSchema) });

/** Where to send the browser next: the provider's authorization endpoint. */
export const ssoRedirectSchema = z.strictObject({ url: z.url() });

export type SsoRedirect = z.infer<typeof ssoRedirectSchema>;

/**
 * What a provider sends back to the callback. Not strict: providers add parameters of their own
 * (Google's `scope`, `authuser`, `prompt`), which are ignored.
 */
export const ssoCallbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  iss: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
});

/** One of the account's linked sign-ins (domain.md, Glossary). */
export const linkedSignInSchema = z.strictObject({
  id: z.uuid(),
  providerId: z.uuid(),
  providerName: z.string(),
  providerKind: z.enum(ssoProviderKinds),
  /** Whether its provider is enabled now; a disabled one's link stays and works again once re-enabled. */
  providerEnabled: z.boolean(),
  /** The email the provider reported when it was linked: for display only, never matched on. */
  email: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** False for a user's last linked sign-in, which can't be unlinked. */
  removable: z.boolean(),
});

export type LinkedSignIn = z.infer<typeof linkedSignInSchema>;

export const linkedSignInsSchema = z.strictObject({
  /** Oldest first. */
  linkedSignIns: z.array(linkedSignInSchema),
});

export type LinkedSignIns = z.infer<typeof linkedSignInsSchema>;

/*
 * Where the callback sends the browser (303). The SPA's `/sign-in/complete` asks for the session
 * and goes on to `/admin`, `/files` or the second-factor step: the session cookie is Strict, so
 * the page the redirect lands on can't be chosen by it.
 */
export const SSO_SIGN_IN_COMPLETE_PATH = "/sign-in/complete";
/** Every failed SSO sign-in lands here, whatever the reason (threat model, T9). */
export const SSO_SIGN_IN_FAILED_PATH = "/sign-in?error=sign-in-failed";
export const LINKED_SIGN_INS_PATH = "/settings/linked-sign-ins";

/** The `?error=` Settings → Linked sign-ins is sent back with when a link isn't made. */
export const linkFailures = ["identity-already-linked", "link-failed"] as const;
export type LinkFailure = (typeof linkFailures)[number];

/* The admin's Sign-in providers tab. Every write needs a recent sign-in. */

export const listSsoProvidersRoute = defineRoute({
  method: "GET",
  path: "/api/v1/admin/sso-providers",
  access: "admin",
  recentSignIn: false,
  safe: true,
  responses: { 200: ssoProvidersSchema },
});

/**
 * A generic OIDC issuer is checked by discovery first (422 `sso-discovery-failed`); issuers are
 * unique (409 `sso-issuer-taken`), and so are ids (409 `sso-provider-id-taken`).
 */
export const addSsoProviderRoute = defineRoute({
  method: "POST",
  path: "/api/v1/admin/sso-providers",
  access: "admin",
  recentSignIn: true,
  safe: false,
  body: addSsoProviderRequestSchema,
  responses: { 201: ssoProviderSchema },
});

export const changeSsoProviderRoute = defineRoute({
  method: "PATCH",
  path: "/api/v1/admin/sso-providers/:id",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: providerParams,
  body: changeSsoProviderRequestSchema,
  responses: { 200: ssoProviderSchema },
});

/** Refused (409 `sso-provider-in-use`) while any linked sign-in uses it: disable it instead. */
export const removeSsoProviderRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/admin/sso-providers/:id",
  access: "admin",
  recentSignIn: true,
  safe: false,
  params: providerParams,
  responses: { 204: z.undefined() },
});

/* Signing in (threat model, T9). */

export const listSignInProvidersRoute = defineRoute({
  method: "GET",
  path: "/api/v1/sso/providers",
  access: "public",
  recentSignIn: false,
  safe: true,
  responses: { 200: signInProvidersSchema },
});

/**
 * Starts a sign-in through an enabled provider: sets the `__Host-nu_sso` cookie and answers where
 * to go (502 `sso-provider-unreachable` when the provider can't be reached).
 */
export const startSsoSignInRoute = defineRoute({
  method: "POST",
  path: "/api/v1/sso/:id/start",
  access: "public",
  recentSignIn: false,
  safe: false,
  params: providerParams,
  responses: { 200: ssoRedirectSchema },
});

/**
 * The only GET that changes state (threat model, T3): a provider sends the browser here
 * cross-site, so it is protected by `state`, PKCE and the `__Host-nu_sso` cookie instead of the
 * CSRF checks. It always answers 303, to the page the flow's purpose chooses.
 */
export const ssoCallbackRoute = defineRoute({
  method: "GET",
  path: "/api/v1/sso/:id/callback",
  access: "public",
  recentSignIn: false,
  safe: false,
  ssoCallback: true,
  params: providerParams,
  query: ssoCallbackQuerySchema,
  responses: { 303: z.undefined() },
});

/* Settings → Linked sign-ins, for the admin and users alike. */

export const listLinkedSignInsRoute = defineRoute({
  method: "GET",
  path: "/api/v1/settings/linked-sign-ins",
  access: "account",
  recentSignIn: false,
  safe: true,
  responses: { 200: linkedSignInsSchema },
});

/**
 * Starts linking an identity at an enabled provider to the caller's account; the callback makes
 * the link, or sends the browser back with `?error=identity-already-linked`. 502
 * `sso-provider-unreachable` when the provider can't be reached.
 */
export const startLinkRoute = defineRoute({
  method: "POST",
  path: "/api/v1/settings/linked-sign-ins",
  access: "account",
  recentSignIn: true,
  safe: false,
  body: z.strictObject({ providerId: z.uuid() }),
  responses: { 200: ssoRedirectSchema },
});

/** Refused (409 `last-sign-in-method`) for a user's last linked sign-in. */
export const unlinkRoute = defineRoute({
  method: "DELETE",
  path: "/api/v1/settings/linked-sign-ins/:id",
  access: "account",
  recentSignIn: true,
  safe: false,
  params: providerParams,
  responses: { 204: z.undefined() },
});
