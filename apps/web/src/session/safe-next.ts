import type { Role } from "@not-unreachable/contracts";

/** Where each role lands after sign-in (domain.md, "The two interfaces after one login"). */
export function landingPath(role: Role): string {
  return role === "admin" ? "/admin" : "/files";
}

/** The SPA route trees each role may be sent back to after sign-in. */
const allowedTrees: Record<Role, readonly string[]> = {
  admin: ["/admin", "/settings"],
  user: ["/files", "/settings"],
};

/** A share link's page (`/s/<token>`), which either role may come back to after signing in to open it. */
const sharePagePrefix = "/s/";

// oxlint-disable-next-line no-control-regex -- control characters are exactly what it looks for.
const controlCharacters = /[\u0000-\u001f\u007f]/;

/** A base that no real path resolves against, so any absolute URL shows up as another origin. */
const probeOrigin = "https://next.invalid";

function looksUnsafe(path: string): boolean {
  return !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || controlCharacters.test(path);
}

function inTree(pathname: string, tree: string): boolean {
  return pathname === tree || pathname.startsWith(`${tree}/`);
}

function isSharePage(pathname: string): boolean {
  return pathname.startsWith(sharePagePrefix) && pathname.length > sharePagePrefix.length;
}

/**
 * The `?next=` of the sign-in page, if it is safe to go to (threat model, T15): a relative path
 * starting with exactly one `/`, with no backslash, scheme or control character (also once
 * percent-decoded), inside a route tree of the role or a share link's page. Anything else gives the
 * role's landing page.
 */
export function safeNextPath(value: string | null | undefined, role: Role): string {
  const landing = landingPath(role);
  if (value == null || value === "" || value.length > 2048 || looksUnsafe(value)) return landing;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return landing;
  }
  if (looksUnsafe(decoded)) return landing;

  let url: URL;
  try {
    url = new URL(value, probeOrigin);
  } catch {
    return landing;
  }
  if (url.origin !== probeOrigin) return landing;
  if (!isSharePage(url.pathname) && !allowedTrees[role].some((tree) => inTree(url.pathname, tree))) return landing;
  return url.pathname + url.search + url.hash;
}
