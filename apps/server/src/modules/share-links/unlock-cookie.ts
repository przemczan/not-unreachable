import { TOKEN_PATTERN } from "../platform/index.ts";

/*
 * A link password's unlock (threat model, T8): a random token in `__Host-nu_unlock_<linkId>`, one
 * cookie per link, so unlocking one link never unlocks another.
 */

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

export const unlockCookieName = (shareLinkId: string): string => `__Host-nu_unlock_${shareLinkId}`;

export function unlockCookie(shareLinkId: string, token: string, maxAgeSeconds: number): string {
  return `${unlockCookieName(shareLinkId)}=${token}; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`;
}

/** The link's unlock token from a `Cookie` header: the first well-formed one, if any. */
export function readUnlockToken(header: string | undefined, shareLinkId: string): string | undefined {
  if (header === undefined) return undefined;
  const name = unlockCookieName(shareLinkId);
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    if (TOKEN_PATTERN.test(value)) return value;
  }
  return undefined;
}
