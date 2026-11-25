import { problemTypes, ssoCallbackPath, type SsoProviderKind } from "@not-unreachable/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api/index.ts";
import { isProblem, problemMessage } from "./validation.ts";

/** How each kind of sign-in provider is named on screen. */
export const providerKindLabels: Record<SsoProviderKind, string> = {
  google: "Google",
  github: "GitHub",
  oidc: "OpenID Connect",
};

/** A provider's redirect URI, as the server builds it: on the `PUBLIC_ORIGIN` it reports, never this page's. */
export function ssoRedirectUri(publicOrigin: string, providerId: string): string {
  return new URL(ssoCallbackPath(providerId), publicOrigin).href;
}

/** The enabled providers, as the sign-in page and Settings → Linked sign-ins offer them. */
export const signInProvidersQuery = queryOptions({
  queryKey: ["sign-in-providers"] as const,
  queryFn: ({ signal }) => api("listSignInProviders", { signal }),
  staleTime: 60_000,
});

/** A sentence for a failed single sign-on request, with wording for each of its problems. */
export function ssoProblemMessage(error: unknown, fallback: string): string {
  if (isProblem(error, problemTypes.lastSignInMethod))
    return "This is your last way to sign in, so it can't be unlinked. Link another one first.";
  if (isProblem(error, problemTypes.ssoIssuerTaken)) return "Another provider already uses this issuer.";
  if (isProblem(error, problemTypes.ssoDiscoveryFailed)) {
    return "The provider's settings could not be read from this issuer. Check the address and try again.";
  }
  if (isProblem(error, problemTypes.ssoProviderIdTaken)) return "This provider was added already. Close this and check the list.";
  if (isProblem(error, problemTypes.ssoProviderInUse)) {
    return "People sign in with this provider, so it can't be removed. Turn it off instead.";
  }
  return problemMessage(error, fallback);
}
