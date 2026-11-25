import { TOKEN_PATTERN } from "../platform/index.ts";

/**
 * Binds a passwordless sign-in's challenge to the browser that asked for it (threat model, T10):
 * `SameSite=Strict`, and it lives as long as the challenge, 5 minutes.
 */
export const WEBAUTHN_COOKIE = "__Host-nu_webauthn";

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

export function webAuthnCookie(token: string): string {
  return `${WEBAUTHN_COOKIE}=${token}; ${ATTRIBUTES}; Max-Age=300`;
}

/** Answered by every passwordless verify: a challenge is used once, whatever happens. */
export function clearedWebAuthnCookie(): string {
  return `${WEBAUTHN_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
}

/** The token from a `Cookie` header: the first well-formed one named {@link WEBAUTHN_COOKIE}, if any. */
export function readWebAuthnToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== WEBAUTHN_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (TOKEN_PATTERN.test(value)) return value;
  }
  return undefined;
}
