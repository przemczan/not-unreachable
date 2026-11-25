/*
 * Fake SSO providers for tests: a generic OIDC provider and GitHub, each a local node:http server
 * that `fakeProvidersFetch` routes the real https hosts to.
 *
 * T9 names `oidc-provider` as the mock. These are built on jose instead because a test must be able
 * to forge bad answers (an ID token signed by another key, or with the wrong iss, aud, exp or
 * nonce), which a certified provider never sends.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { GITHUB_ISSUER } from "@not-unreachable/contracts";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import type { Clock } from "../modules/platform/index.ts";
import type { SsoFetch } from "../modules/sso/index.ts";

export const FAKE_ISSUER = "https://idp.test";
export const FAKE_CLIENT_ID = "nu-client";
export const FAKE_CLIENT_SECRET = "s3cr3t-client-secret-value-0123456789";

/** Who signs in at the fake provider. */
export interface FakeIdentity {
  readonly sub: string;
  readonly email?: string;
  /** The ID token's `email_verified` with the email: true when left out, no claim at all when null. */
  readonly emailVerified?: boolean | string | null;
  readonly name?: string;
}

const emailClaims = ({ email, emailVerified = true }: FakeIdentity): Record<string, unknown> => {
  if (email === undefined) return {};
  return emailVerified === null ? { email } : { email, email_verified: emailVerified };
};

/** How the next ID tokens are forged. */
export interface IdTokenTampering {
  readonly signWithOtherKey?: boolean;
  readonly iss?: string;
  readonly aud?: string;
  readonly nonce?: string;
  /** Seconds from now; negative for a token expired already. 300 when left out. */
  readonly expiresIn?: number;
}

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | null;
  readonly identity: FakeIdentity;
}

/** What one token request carried, as the fake received it. */
export interface TokenRequest {
  readonly parameters: URLSearchParams;
  /** Whether its `code_verifier` matched the authorization request's S256 challenge. */
  readonly pkceMatched: boolean;
}

interface FakeServer {
  readonly origin: string;
  close(): Promise<void>;
}

async function listen(
  handle: (request: IncomingMessage, body: string, response: ServerResponse) => void | Promise<void>,
): Promise<FakeServer> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      Promise.resolve(handle(request, Buffer.concat(chunks).toString("utf8"), response)).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

/** Approves an authorization request: records it and answers where the provider would send the browser. */
function approve(url: string, identity: FakeIdentity, codes: Map<string, PendingCode>, iss: string | null): URL {
  const request = new URL(url);
  const parameters = request.searchParams;
  if (parameters.get("response_type") !== "code") throw new Error("The fake expects response_type=code");
  if (parameters.get("code_challenge_method") !== "S256") throw new Error("The fake expects a PKCE S256 challenge");
  const code = randomBytes(16).toString("base64url");
  codes.set(code, {
    clientId: parameters.get("client_id") ?? "",
    redirectUri: parameters.get("redirect_uri") ?? "",
    codeChallenge: parameters.get("code_challenge") ?? "",
    nonce: parameters.get("nonce"),
    identity,
  });
  const redirect = new URL(parameters.get("redirect_uri") ?? "");
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", parameters.get("state") ?? "");
  if (iss !== null) redirect.searchParams.set("iss", iss);
  return redirect;
}

/** Checks a token request's client, redirect URI and PKCE verifier; answers its pending code, or why not. */
function redeem(
  parameters: URLSearchParams,
  codes: Map<string, PendingCode>,
  clientSecret: string,
  requests: TokenRequest[],
): PendingCode | string {
  const code = parameters.get("code") ?? "";
  const pending = codes.get(code);
  codes.delete(code);
  const pkceMatched = pending !== undefined && s256(parameters.get("code_verifier") ?? "") === pending.codeChallenge;
  requests.push({ parameters, pkceMatched });
  if (pending === undefined) return "unknown code";
  if (parameters.get("grant_type") !== "authorization_code") return "wrong grant";
  if (parameters.get("client_id") !== pending.clientId || parameters.get("client_secret") !== clientSecret) return "wrong client";
  if (parameters.get("redirect_uri") !== pending.redirectUri) return "wrong redirect_uri";
  if (!pkceMatched) return "wrong code_verifier";
  return pending;
}

export interface FakeOidcProvider {
  readonly issuer: string;
  readonly origin: string;
  /** What the discovery document names as the issuer; the real one unless changed. */
  discoveryIssuer: string;
  /** Discovery never answers while set, for the timeout. */
  hangDiscovery: boolean;
  tamper: IdTokenTampering;
  readonly authorizationRequests: URL[];
  readonly tokenRequests: TokenRequest[];
  /** The clock ID tokens are issued by; the app's, once the test has one. */
  useClock(clock: Clock): void;
  /** Approves an authorization request as `identity`; answers the callback URL the browser would be sent to. */
  authorize(url: string, identity: FakeIdentity): URL;
  close(): Promise<void>;
}

export async function startFakeOidcProvider(
  options: { readonly issuer?: string; readonly clientSecret?: string } = {},
): Promise<FakeOidcProvider> {
  const issuer = options.issuer ?? FAKE_ISSUER;
  const clientSecret = options.clientSecret ?? FAKE_CLIENT_SECRET;
  const signing = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(signing.publicKey)), kid: "fake-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, PendingCode>();
  let clock: Clock = { now: () => new Date() };

  const idToken = async (pending: PendingCode, tamper: IdTokenTampering): Promise<string> => {
    const now = Math.floor(clock.now().getTime() / 1000);
    const key: CryptoKey = tamper.signWithOtherKey === true ? other.privateKey : signing.privateKey;
    const nonce = tamper.nonce ?? pending.nonce;
    return new SignJWT({
      ...(nonce === null ? {} : { nonce }),
      ...emailClaims(pending.identity),
      ...(pending.identity.name === undefined ? {} : { name: pending.identity.name }),
    })
      .setProtectedHeader({ alg: "RS256", kid: "fake-key" })
      .setIssuer(tamper.iss ?? issuer)
      .setAudience(tamper.aud ?? pending.clientId)
      .setSubject(pending.identity.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + (tamper.expiresIn ?? 300))
      .sign(key);
  };

  const fake: FakeOidcProvider = {
    issuer,
    origin: "",
    discoveryIssuer: issuer,
    hangDiscovery: false,
    tamper: {},
    authorizationRequests: [],
    tokenRequests: [],
    useClock: (next) => {
      clock = next;
    },
    authorize: (url, identity) => {
      fake.authorizationRequests.push(new URL(url));
      return approve(url, identity, codes, null);
    },
    close: async () => undefined,
  };

  const server = await listen(async (request, body, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (path === "/.well-known/openid-configuration") {
      if (fake.hangDiscovery) return;
      json(response, 200, {
        issuer: fake.discoveryIssuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
      return;
    }
    if (path === "/jwks") {
      json(response, 200, { keys: [jwk] });
      return;
    }
    if (path === "/token" && request.method === "POST") {
      const pending = redeem(new URLSearchParams(body), codes, clientSecret, fake.tokenRequests);
      if (typeof pending === "string") {
        json(response, 400, { error: "invalid_grant", error_description: pending });
        return;
      }
      json(response, 200, {
        access_token: randomBytes(16).toString("base64url"),
        token_type: "Bearer",
        expires_in: 300,
        id_token: await idToken(pending, fake.tamper),
      });
      return;
    }
    json(response, 404, { error: "not_found" });
  });
  return Object.assign(fake, { origin: server.origin, close: () => server.close() });
}

export interface FakeGitHubUser {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly emails: readonly { readonly email: string; readonly primary: boolean; readonly verified: boolean }[];
}

export interface FakeGitHub {
  readonly origin: string;
  readonly authorizationRequests: URL[];
  readonly tokenRequests: TokenRequest[];
  /** Approves an authorization request as `user`; answers the callback URL the browser would be sent to. */
  authorize(url: string, user: FakeGitHubUser): URL;
  close(): Promise<void>;
}

/** GitHub's OAuth endpoints and REST API, on one server for both github.com and api.github.com. */
export async function startFakeGitHub(options: { readonly clientSecret?: string } = {}): Promise<FakeGitHub> {
  const clientSecret = options.clientSecret ?? FAKE_CLIENT_SECRET;
  const codes = new Map<string, PendingCode>();
  const users = new Map<string, FakeGitHubUser>();
  const usersByCode = new Map<string, FakeGitHubUser>();

  const fake: FakeGitHub = {
    origin: "",
    authorizationRequests: [],
    tokenRequests: [],
    authorize: (url, user) => {
      fake.authorizationRequests.push(new URL(url));
      const redirect = approve(url, { sub: String(user.id) }, codes, null);
      usersByCode.set(redirect.searchParams.get("code") ?? "", user);
      return redirect;
    },
    close: async () => undefined,
  };

  const server = await listen((request, body, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (path === "/login/oauth/access_token" && request.method === "POST") {
      const parameters = new URLSearchParams(body);
      const user = usersByCode.get(parameters.get("code") ?? "");
      const pending = redeem(parameters, codes, clientSecret, fake.tokenRequests);
      // Like GitHub: a refused exchange is still a 200, with an `error`.
      if (typeof pending === "string" || user === undefined) {
        json(response, 200, { error: "bad_verification_code", error_description: typeof pending === "string" ? pending : "unknown code" });
        return;
      }
      const token = `gho_${randomBytes(16).toString("hex")}`;
      users.set(token, user);
      json(response, 200, { access_token: token, token_type: "bearer", scope: "read:user,user:email" });
      return;
    }
    const user = users.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (user === undefined) {
      json(response, 401, { message: "Bad credentials" });
      return;
    }
    if (path === "/user") json(response, 200, { id: user.id, login: user.login, name: user.name });
    else if (path === "/user/emails") json(response, 200, user.emails);
    else json(response, 404, { message: "Not Found" });
  });
  return Object.assign(fake, { origin: server.origin, close: () => server.close() });
}

/**
 * Routes each https origin to its local fake, and refuses every other one, so a test never reaches
 * the network. GitHub's two hosts go to the one fake.
 */
export function fakeProvidersFetch(targets: Readonly<Record<string, string>>): SsoFetch {
  return (url, { method, headers, body, redirect, signal }) => {
    const requested = new URL(url);
    const target = targets[requested.origin];
    if (target === undefined) return Promise.reject(new TypeError(`No fake for ${requested.origin}`));
    return globalThis.fetch(new URL(`${requested.pathname}${requested.search}`, target), {
      method,
      headers,
      body: body ?? null,
      redirect,
      ...(signal === undefined ? {} : { signal }),
    });
  };
}

/** The targets for {@link fakeProvidersFetch}: the OIDC fake at its issuer, and GitHub's hosts. */
export function fakeTargets(oidc: FakeOidcProvider | undefined, github: FakeGitHub | undefined): Record<string, string> {
  return {
    ...(oidc === undefined ? {} : { [new URL(oidc.issuer).origin]: oidc.origin }),
    ...(github === undefined ? {} : { [GITHUB_ISSUER]: github.origin, "https://api.github.com": github.origin }),
  };
}
