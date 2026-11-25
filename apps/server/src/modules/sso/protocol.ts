import { GITHUB_ISSUER, type SsoProviderKind } from "@not-unreachable/contracts";
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  clockSkew,
  Configuration,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  type CustomFetch,
  type ServerMetadata,
} from "openid-client";
import { z } from "zod";
import { MINUTE_MS, type Clock } from "../platform/index.ts";

export type SsoFetch = CustomFetch;

/**
 * The identity a provider vouched for. Only (issuer, subject) ever links a sign-in; `email` and
 * `name` are display. `verifiedEmails` is what an invitation that requires a verified email is
 * checked against (threat model, T9).
 */
export interface SsoIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly name: string | null;
  /** The emails the provider reports as verified: GitHub's verified ones, OIDC's with `email_verified`. */
  readonly verifiedEmails: readonly string[];
}

/** What the protocol layer needs to know of a provider. */
export interface ProviderEndpoint {
  readonly kind: SsoProviderKind;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AuthorizationParameters {
  readonly redirectUri: string;
  readonly state: string;
  /** Null for GitHub, which has no ID token. */
  readonly nonce: string | null;
  readonly codeChallenge: string;
}

export interface CallbackParameters {
  readonly redirectUri: string;
  readonly code: string | undefined;
  readonly state: string | undefined;
  readonly iss: string | undefined;
  readonly expectedState: string;
  readonly expectedNonce: string | null;
  readonly codeVerifier: string;
}

/** The provider couldn't be reached at the issuer, or its discovery document names another issuer. */
export class DiscoveryFailedError extends Error {
  override readonly name = "DiscoveryFailedError";
}

/**
 * OIDC (Google and generic) through openid-client: discovery, authorization code with PKCE, and the
 * ID token's signature (JWKS), `iss`, `aud`, `exp` and `nonce`. GitHub is OAuth 2: the same library
 * runs the code + PKCE exchange, then the account comes from its REST API (stack.md).
 */
export interface SsoProtocol {
  /** Throws {@link DiscoveryFailedError} unless discovery at `issuer` answers exactly that issuer. */
  checkIssuer(issuer: string): Promise<void>;
  authorizationUrl(provider: ProviderEndpoint, parameters: AuthorizationParameters): Promise<URL>;
  /** Exchanges the code and checks what comes back; throws on anything wrong. */
  exchange(provider: ProviderEndpoint, parameters: CallbackParameters): Promise<SsoIdentity>;
}

export interface SsoProtocolDependencies {
  /** Every outbound call goes through it; tests route the providers' hosts to local fakes. */
  readonly fetch: SsoFetch;
  readonly clock: Clock;
  readonly discoveryTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export const GITHUB_ENDPOINTS = {
  authorize: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  user: "https://api.github.com/user",
  emails: "https://api.github.com/user/emails",
} as const;

export const scopesOf = (kind: SsoProviderKind): string => (kind === "github" ? "read:user user:email" : "openid email profile");

const githubMetadata: ServerMetadata = {
  issuer: GITHUB_ISSUER,
  authorization_endpoint: GITHUB_ENDPOINTS.authorize,
  token_endpoint: GITHUB_ENDPOINTS.token,
};

/** A discovery document is fetched again after this long, so a provider's changed endpoints are picked up. */
const METADATA_LIFETIME_MS = 60 * MINUTE_MS;
/** How long an outdated discovery document still serves after the provider failed to answer for a new one. */
const METADATA_RETRY_MS = MINUTE_MS;

const githubUser = z.looseObject({ id: z.int().positive(), login: z.string(), name: z.string().nullish() });
const githubEmails = z.array(z.looseObject({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

/**
 * OIDC's `email_verified`: true, or the string "true" some IdPs send. A provider that leaves it out
 * (Microsoft Entra, for one) never vouches for the email.
 */
const isVerifiedClaim = (claim: unknown): boolean => claim === true || claim === "true";

export function createSsoProtocol({ fetch, clock, discoveryTimeoutMs, requestTimeoutMs }: SsoProtocolDependencies): SsoProtocol {
  const metadataCache = new Map<string, { readonly metadata: ServerMetadata; readonly at: number }>();

  const discover = async (issuer: string): Promise<ServerMetadata> => {
    let metadata: ServerMetadata;
    try {
      const discovered = await discovery(new URL(issuer), "discovery", undefined, undefined, {
        [customFetch]: fetch,
        timeout: discoveryTimeoutMs / 1000,
      });
      metadata = { ...discovered.serverMetadata() };
    } catch (error) {
      throw new DiscoveryFailedError(`Discovery failed at the issuer: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    // openid-client compares normalised URLs; links are matched on the issuer as stored, so it must be exact.
    if (metadata.issuer !== issuer) throw new DiscoveryFailedError("The discovery document names another issuer");
    return metadata;
  };

  const metadataOf = async (provider: ProviderEndpoint): Promise<ServerMetadata> => {
    if (provider.kind === "github") return githubMetadata;
    const now = clock.now().getTime();
    const cached = metadataCache.get(provider.issuer);
    if (cached !== undefined && now - cached.at < METADATA_LIFETIME_MS) return cached.metadata;
    let metadata: ServerMetadata;
    try {
      metadata = await discover(provider.issuer);
    } catch (error) {
      if (cached === undefined || !(error instanceof DiscoveryFailedError)) throw error;
      // A provider briefly out of reach keeps working on what it last published, and isn't asked
      // again for a while, so each sign-in doesn't wait out the discovery timeout first.
      metadataCache.set(provider.issuer, { metadata: cached.metadata, at: now - METADATA_LIFETIME_MS + METADATA_RETRY_MS });
      return cached.metadata;
    }
    metadataCache.set(provider.issuer, { metadata, at: now });
    return metadata;
  };

  const configurationOf = async (provider: ProviderEndpoint): Promise<Configuration> => {
    const configuration = new Configuration(await metadataOf(provider), provider.clientId, {
      client_secret: provider.clientSecret,
      // The ID token's times are checked against the app's clock, not the process's.
      [clockSkew]: Math.round((clock.now().getTime() - Date.now()) / 1000),
    });
    configuration[customFetch] = fetch;
    configuration.timeout = requestTimeoutMs / 1000;
    // The token endpoint's TLS alone would do for OIDC; checking the signature too is what T9 asks.
    if (provider.kind !== "github") enableNonRepudiationChecks(configuration);
    return configuration;
  };

  const github = async (url: string, accessToken: string): Promise<unknown> => {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "NotUnreachable",
        "x-github-api-version": "2022-11-28",
      },
      body: undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
  };

  const githubIdentity = async (accessToken: string): Promise<SsoIdentity> => {
    const user = githubUser.parse(await github(GITHUB_ENDPOINTS.user, accessToken));
    // The sign-in goes on without the emails; only an invitation that requires a verified one fails.
    const emails = githubEmails.safeParse(await github(GITHUB_ENDPOINTS.emails, accessToken).catch(() => undefined));
    const verified = emails.success ? emails.data.filter((email) => email.verified) : [];
    const primary = verified.find((email) => email.primary);
    return {
      issuer: GITHUB_ISSUER,
      subject: String(user.id),
      email: primary?.email ?? null,
      name: user.name ?? user.login,
      verifiedEmails: verified.map((email) => email.email),
    };
  };

  return {
    async checkIssuer(issuer) {
      await discover(issuer);
    },

    async authorizationUrl(provider, { redirectUri, state, nonce, codeChallenge }) {
      return buildAuthorizationUrl(await configurationOf(provider), {
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopesOf(provider.kind),
        state,
        ...(nonce === null ? {} : { nonce }),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
    },

    async exchange(provider, { redirectUri, code, state, iss, expectedState, expectedNonce, codeVerifier }) {
      // Built from PUBLIC_ORIGIN and the parsed query, never the request's Host (threat model, T15).
      const currentUrl = new URL(redirectUri);
      if (code !== undefined) currentUrl.searchParams.set("code", code);
      if (state !== undefined) currentUrl.searchParams.set("state", state);
      if (iss !== undefined) currentUrl.searchParams.set("iss", iss);
      const configuration = await configurationOf(provider);
      const tokens = await authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState,
        ...(expectedNonce === null ? {} : { expectedNonce }),
        idTokenExpected: provider.kind !== "github",
      });
      if (provider.kind === "github") return githubIdentity(tokens.access_token);
      const claims = tokens.claims();
      if (claims === undefined) throw new Error("No ID token");
      const email = typeof claims["email"] === "string" ? claims["email"] : null;
      return {
        issuer: provider.issuer,
        subject: claims.sub,
        email,
        name: typeof claims["name"] === "string" ? claims["name"] : null,
        verifiedEmails: email !== null && isVerifiedClaim(claims["email_verified"]) ? [email] : [],
      };
    },
  };
}
