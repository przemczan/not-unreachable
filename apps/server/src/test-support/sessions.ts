import type { RouteContract } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { sameOriginWrite, viaProxy, type TestApp } from "./app.ts";

/** A parameter value every `:name` of a route path gets: a well-formed id nobody has. */
export const UNKNOWN_ID = "01900000-0000-7000-8000-000000000000";

/** The route's path with every `:name` filled in. */
export function concretePath(route: Pick<RouteContract, "path">, value = UNKNOWN_ID): string {
  return route.path.replaceAll(/:[A-Za-z]+/g, value);
}

/**
 * Calls a route as the SPA would (over the proxy, with the CSRF headers on a write), with the
 * session `cookie` when given.
 */
export function callRoute(
  test: Pick<TestApp, "app">,
  route: Pick<RouteContract, "method" | "path">,
  options: { readonly cookie?: string; readonly payload?: object; readonly params?: string; readonly query?: string } = {},
): Promise<LightMyRequestResponse> {
  const safe = route.method === "GET" || route.method === "HEAD";
  const headers: Record<string, string> = { ...(safe ? viaProxy : sameOriginWrite) };
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  const query = options.query === undefined ? "" : `?${options.query}`;
  return test.app.inject({
    method: route.method,
    url: `${concretePath(route, options.params)}${query}`,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** The rows of a table, as SQLite stores them. */
export function tableRows(test: Pick<TestApp, "database">, table: string): Record<string, unknown>[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SQLite rows are plain objects.
  return test.database.sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}
