import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createBrowserRouter, useLocation, type RouteObject } from "react-router";
import { NotFound } from "./pages/not-found.tsx";
import { RouteError } from "./pages/route-error.tsx";
import { landingPath, secondFactorPath, setupStatusQuery, useSession } from "./session/index.ts";

/**
 * Each page brings its own layout (AuthLayout, AppShell or PublicLayout), with its `main` landmark.
 * Until the admin exists, every page is /setup.
 */
function Root() {
  const status = useQuery(setupStatusQuery);
  const { pathname } = useLocation();
  if (status.isPending) return null;
  if (status.isError) throw status.error;
  if (!status.data.adminExists && pathname !== "/setup") return <Navigate replace to="/setup" />;
  return <Outlet />;
}

/** `/`: the signed-in account's interface, the second-factor step, or the sign-in page. */
function Home() {
  const { data: session, isPending, isError, error } = useSession();
  if (isPending) return null;
  // The server or the network failed: say so, rather than send someone who is signed in to sign in.
  if (isError) throw error;
  if (session == null) return <Navigate replace to="/sign-in" />;
  return <Navigate replace to={session.state === "pendingSecondFactor" ? secondFactorPath : landingPath(session.account.role)} />;
}

function Loading() {
  return null;
}

/**
 * The SPA's routes (domain.md, "The two interfaces after one login"). Each interface is a lazy
 * route, so it is a chunk of its own: a user's browser never downloads the admin interface. The
 * shared account settings are a chunk of their own too, importing neither interface.
 */
export const routes: RouteObject[] = [
  // The public share page: a tree and a chunk of its own, outside Root, as it needs neither the
  // setup status nor a session, and imports nothing of either interface (threat model, T8).
  { path: "s/:token", lazy: () => import("./pages/share.tsx"), HydrateFallback: Loading, ErrorBoundary: RouteError },
  {
    Component: Root,
    HydrateFallback: Loading,
    ErrorBoundary: RouteError,
    children: [
      { index: true, Component: Home },
      { path: "setup", lazy: () => import("./pages/setup.tsx") },
      { path: "sign-in", lazy: () => import("./pages/sign-in.tsx") },
      { path: "sign-in/complete", lazy: () => import("./pages/sign-in-complete.tsx") },
      { path: "sign-in/second-factor", lazy: () => import("./pages/second-factor.tsx") },
      // Public link pages: they work signed out, and signed in too (nobody is sent away from them).
      { path: "invitation/:token", lazy: () => import("./pages/invitation.tsx") },
      { path: "relink/:token", lazy: () => import("./pages/relink.tsx") },
      { path: "admin/*", lazy: () => import("./admin/admin.tsx") },
      { path: "files/*", lazy: () => import("./pages/files.tsx") },
      { path: "shared", lazy: () => import("./pages/shared-with-me.tsx") },
      { path: "settings/*", lazy: () => import("./settings/settings.tsx") },
      { path: "*", Component: NotFound },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
