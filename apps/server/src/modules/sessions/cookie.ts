import { TOKEN_PATTERN } from "../platform/index.ts";

/** Threat model, T2: `__Host-` binds it to this origin, with Path=/ and no Domain. */
export const SESSION_COOKIE = "__Host-nu_session";

// No Max-Age or Expires: a browser-session cookie, as the timeouts are the server's.
const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

/** The `Set-Cookie` value that hands the browser its session token. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${ATTRIBUTES}`;
}

/** The `Set-Cookie` value that removes the session cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
}

/** The session token from a `Cookie` header: the first well-formed one named {@link SESSION_COOKIE}, if any. */
export function readSessionToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (TOKEN_PATTERN.test(value)) return value;
  }
  return undefined;
}
