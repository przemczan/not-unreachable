import type { z } from "zod";

/**
 * Who may call a route. The server's guard enforces it before any handler runs (domain.md, rule 5):
 * - `public`: anyone, signed in or not;
 * - `pendingSecondFactor`: any session, even one still waiting for its second factor;
 * - `account`: an active session of either role;
 * - `user`: an active session of a user, never the admin;
 * - `admin`: an active session of the admin, never a user.
 */
export const accessLevels = ["public", "pendingSecondFactor", "account", "user", "admin"] as const;
export type Access = (typeof accessLevels)[number];

export const safeMethods = ["GET", "HEAD"] as const;
export const unsafeMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type SafeMethod = (typeof safeMethods)[number];
export type UnsafeMethod = (typeof unsafeMethods)[number];
export type HttpMethod = SafeMethod | UnsafeMethod;

/**
 * A safe route never changes state (threat model, T3), so only GET and HEAD may be safe,
 * and they always are: CSRF checks apply to every other method. The one exception is the SSO
 * callback, a GET a provider sends the browser to cross-site, marked `ssoCallback`: `state`, PKCE
 * and the `__Host-nu_sso` cookie protect it instead (T9).
 */
type RouteSafety =
  | { readonly method: SafeMethod; readonly safe: true; readonly ssoCallback?: never }
  | { readonly method: UnsafeMethod; readonly safe: false; readonly ssoCallback?: never }
  | { readonly method: "GET"; readonly safe: false; readonly ssoCallback: true };

export type RouteContract = RouteSafety & {
  /** Fastify-style path under `/api/v1`, with `:name` parameters. */
  readonly path: `/api/v1/${string}`;
  readonly access: Access;
  /** The caller must have proved a password or factor in the last 10 minutes. */
  readonly recentSignIn: boolean;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /**
   * A body the handler reads itself, unparsed, as a stream (tus chunks): the CSRF checks accept this
   * media type instead of JSON, and the handler stops reading past `maxBytes`. Never with `body`.
   */
  readonly rawBody?: { readonly mediaType: string; readonly maxBytes: number };
  /** Success responses by status code; errors are always problem+json. */
  readonly responses: Readonly<Partial<Record<number, z.ZodType>>>;
};

export type RouteTable = Readonly<Record<string, RouteContract>>;

/** Keeps a route's literal types, so the server and the web client infer its schemas. */
export function defineRoute<const Route extends RouteContract>(route: Route): Route {
  return route;
}
