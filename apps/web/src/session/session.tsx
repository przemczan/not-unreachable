import type { Role, Session } from "@not-unreachable/contracts";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { Navigate, useLocation } from "react-router";
import { ApiError, api } from "../api/index.ts";
import { landingPath } from "./safe-next.ts";

export const sessionQueryKey = ["session"] as const;
export const setupStatusQueryKey = ["setup-status"] as const;

/** The caller's session, or null when signed out: the one source of who is signed in. */
export const sessionQuery = queryOptions({
  queryKey: sessionQueryKey,
  queryFn: async ({ signal }): Promise<Session | null> => {
    try {
      return await api("getSession", { signal });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 60_000,
});

/** Whether the admin exists yet; it changes only through /setup, which updates it. */
export const setupStatusQuery = queryOptions({
  queryKey: setupStatusQueryKey,
  queryFn: ({ signal }) => api("setupStatus", { signal }),
  staleTime: Infinity,
});

/** The sign-in step after the password, where a `pendingSecondFactor` session has to go. */
export const secondFactorPath = "/sign-in/second-factor";

/** The second-factor step, carrying on the page to go to afterwards. */
export function secondFactorPathWith(next: string | null): string {
  return next === null || next === "" ? secondFactorPath : `${secondFactorPath}?next=${encodeURIComponent(next)}`;
}

export function useSession() {
  return useQuery(sessionQuery);
}

/** The session inside a RequireAccount: always signed in, and past the second factor, there. */
export function useSignedInSession(): Session {
  const { data } = useSession();
  if (data == null) throw new Error("useSignedInSession() needs a <RequireAccount> above it.");
  return data;
}

/** Forgets everything the signed-in account loaded, and the session itself. */
export function clearAccountData(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== sessionQueryKey[0] && query.queryKey[0] !== setupStatusQueryKey[0],
  });
  queryClient.setQueryData(sessionQueryKey, null);
}

export interface RequireAccountProps {
  /** The role the pages need; any signed-in account when left out. */
  readonly requiredRole?: Role;
  readonly children?: React.ReactNode;
}

/**
 * Renders its pages only for a signed-in account of the role: a signed-out visitor goes to
 * /sign-in with the page as `?next=`, a session still pending its second factor to that step, the
 * other role to its own landing page. The server enforces access on every request; this only
 * spares the user pages they can't use.
 */
export function RequireAccount({ requiredRole, children }: RequireAccountProps) {
  const { data: session, isPending, isError, error } = useSession();
  const location = useLocation();
  if (isPending) return null;
  if (isError) throw error;
  if (session === null) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate replace to={`/sign-in?next=${next}`} />;
  }
  if (session.state === "pendingSecondFactor") return <Navigate replace to={secondFactorPathWith(location.pathname + location.search)} />;
  if (requiredRole !== undefined && session.account.role !== requiredRole)
    return <Navigate replace to={landingPath(session.account.role)} />;
  return children;
}
