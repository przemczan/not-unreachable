/*
 * A mock OpenID Connect provider for the e2e run, served over TLS (a generic provider's issuer
 * must be https://). playwright.config.ts starts it as a web server, with a self-signed
 * certificate for localhost that the app server trusts through NODE_EXTRA_CA_CERTS.
 *
 * It approves every authorization request at once, as one fixed person (or, when the browser
 * sends the MOCK_OIDC_SUBJECT_COOKIE cookie, as the person that names), and checks what a real
 * provider would at the token endpoint: the code, the client's credentials (Basic or in the body),
 * the redirect URI and the PKCE S256 verifier. ID tokens are RS256, signed with node:crypto alone.
 *
 * Node runs this file by type stripping, so it uses only erasable TypeScript syntax.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MOCK_OIDC_PORT = 8482;
export const MOCK_OIDC_ISSUER = `https://localhost:${MOCK_OIDC_PORT}`;
export const MOCK_OIDC_CLIENT_ID = "nu-e2e-client";
export const MOCK_OIDC_CLIENT_SECRET = "e2e-client-secret-0123456789abcdef";

/** Who signs in at the mock provider. */
export const mockOidcIdentity = { sub: "e2e-admin", email: "ada@example.com", name: "Ada Admin" } as const;

/**
 * A cookie naming who signs in instead, so a spec chooses the person per browser context. Cookies
 * aren't kept apart by port, so it is set for localhost, which the app ignores.
 */
export const MOCK_OIDC_SUBJECT_COOKIE = "nu_mock_oidc_subject";

export interface MockOidcIdentity {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

/** The person a subject chosen by the cookie is: `<sub>@example.com`, named after the subject. */
export const mockOidcIdentityOf = (sub: string): MockOidcIdentity => ({ sub, email: `${sub}@example.com`, name: sub });

/** The cookie for Playwright's `context.addCookies` that makes the mock sign in as `sub`. */
export function mockOidcSubjectCookie(sub: string) {
  return { name: MOCK_OIDC_SUBJECT_COOKIE, value: sub, domain: "localhost", path: "/" };
}

function identityOf(request: IncomingMessage): MockOidcIdentity {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    const sub = value.join("=");
    if (name === MOCK_OIDC_SUBJECT_COOKIE && /^[\w.-]{1,64}$/.test(sub)) return mockOidcIdentityOf(sub);
  }
  return mockOidcIdentity;
}

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | null;
  readonly identity: MockOidcIdentity;
}

const KEY_ID = "e2e-key";

const base64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");
const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

/** RFC 6749 §2.3.1: both halves of Basic credentials are form-urlencoded before being joined. */
const formDecode = (text: string): string => decodeURIComponent(text.replaceAll("+", " "));

/** The client's credentials, by client_secret_basic or client_secret_post. */
function clientCredentials(request: IncomingMessage, parameters: URLSearchParams): { id: string; secret: string } | null {
  const authorization = request.headers.authorization ?? "";
  if (authorization.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    return { id: formDecode(decoded.slice(0, colon)), secret: formDecode(decoded.slice(colon + 1)) };
  }
  const id = parameters.get("client_id");
  const secret = parameters.get("client_secret");
  return id === null || secret === null ? null : { id, secret };
}

export function startMockOidcProvider(options: { readonly cert: string; readonly key: string }): void {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: KEY_ID, alg: "RS256", use: "sig" };
  const codes = new Map<string, PendingCode>();

  const idToken = (pending: PendingCode): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KEY_ID }));
    const payload = base64url(
      JSON.stringify({
        iss: MOCK_OIDC_ISSUER,
        sub: pending.identity.sub,
        aud: pending.clientId,
        iat: now,
        exp: now + 300,
        ...(pending.nonce === null ? {} : { nonce: pending.nonce }),
        email: pending.identity.email,
        email_verified: true,
        name: pending.identity.name,
      }),
    );
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
  };

  const authorize = (request: IncomingMessage, url: URL, response: ServerResponse): void => {
    const parameters = url.searchParams;
    const redirectUri = parameters.get("redirect_uri");
    if (
      redirectUri === null ||
      parameters.get("client_id") !== MOCK_OIDC_CLIENT_ID ||
      parameters.get("response_type") !== "code" ||
      parameters.get("code_challenge_method") !== "S256" ||
      (parameters.get("code_challenge") ?? "") === ""
    ) {
      json(response, 400, { error: "invalid_request" });
      return;
    }
    const code = randomBytes(24).toString("base64url");
    codes.set(code, {
      clientId: MOCK_OIDC_CLIENT_ID,
      redirectUri,
      codeChallenge: parameters.get("code_challenge") ?? "",
      nonce: parameters.get("nonce"),
      identity: identityOf(request),
    });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    const state = parameters.get("state");
    if (state !== null) redirect.searchParams.set("state", state);
    response.writeHead(302, { location: redirect.href, "cache-control": "no-store" }).end();
  };

  const token = (request: IncomingMessage, body: string, response: ServerResponse): void => {
    const parameters = new URLSearchParams(body);
    const code = parameters.get("code") ?? "";
    const pending = codes.get(code);
    // A code is used once, whether or not the exchange passes.
    codes.delete(code);
    const client = clientCredentials(request, parameters);
    if (client === null || client.id !== MOCK_OIDC_CLIENT_ID || !sameText(client.secret, MOCK_OIDC_CLIENT_SECRET)) {
      json(response, 401, { error: "invalid_client" });
      return;
    }
    if (
      pending === undefined ||
      parameters.get("grant_type") !== "authorization_code" ||
      parameters.get("redirect_uri") !== pending.redirectUri ||
      s256(parameters.get("code_verifier") ?? "") !== pending.codeChallenge
    ) {
      json(response, 400, { error: "invalid_grant" });
      return;
    }
    json(response, 200, {
      access_token: randomBytes(24).toString("base64url"),
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken(pending),
    });
  };

  const server = createServer({ cert: readFileSync(options.cert), key: readFileSync(options.key) }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", MOCK_OIDC_ISSUER);
      const body = Buffer.concat(chunks).toString("utf8");
      if (url.pathname === "/.well-known/openid-configuration" && request.method === "GET") {
        json(response, 200, {
          issuer: MOCK_OIDC_ISSUER,
          authorization_endpoint: `${MOCK_OIDC_ISSUER}/authorize`,
          token_endpoint: `${MOCK_OIDC_ISSUER}/token`,
          jwks_uri: `${MOCK_OIDC_ISSUER}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          scopes_supported: ["openid", "email", "profile"],
        });
      } else if (url.pathname === "/jwks" && request.method === "GET") {
        json(response, 200, { keys: [jwk] });
      } else if (url.pathname === "/authorize" && request.method === "GET") {
        authorize(request, url, response);
      } else if (url.pathname === "/token" && request.method === "POST") {
        token(request, body, response);
      } else {
        json(response, 404, { error: "not_found" });
      }
    });
  });
  server.listen(MOCK_OIDC_PORT, "127.0.0.1");
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set: run through playwright.config.ts.`);
  return value;
}

// Started only when run as a program (`node e2e/mock-oidc.ts`), not when a spec imports its constants.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMockOidcProvider({ cert: required("NU_MOCK_OIDC_CERT"), key: required("NU_MOCK_OIDC_KEY") });
}
