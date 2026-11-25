import { TOKEN_PATTERN } from "../platform/index.ts";

/**
 * Binds an SSO flow to the browser that started it (threat model, T3). `SameSite=Lax`, unlike the
 * session cookie, because the provider sends the browser back with a cross-site top-level GET.
 */
export const SSO_COOKIE = "__Host-nu_sso";

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

/** The `Set-Cookie` value for a new flow: it lives as long as the flow, 10 minutes. */
export function ssoCookie(token: string): string {
  return `${SSO_COOKIE}=${token}; ${ATTRIBUTES}; Max-Age=600`;
}

/** The `Set-Cookie` value every callback answers with: a flow is used once, whatever happens. */
export function clearedSsoCookie(): string {
  return `${SSO_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
}

/** The flow token from a `Cookie` header: the first well-formed one named {@link SSO_COOKIE}, if any. */
export function readSsoToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== SSO_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (TOKEN_PATTERN.test(value)) return value;
  }
  return undefined;
}
