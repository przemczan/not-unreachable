import { accessLevels, safeMethods, unsafeMethods, type RouteContract, type RouteTable } from "@not-unreachable/contracts";
import type {
  ContextConfigDefault,
  FastifyInstance,
  FastifySchema,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteGenericInterface,
  RouteHandlerMethod,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

type Field<Route, Key extends string> = Route extends { readonly [K in Key]: infer Schema } ? Schema : undefined;

/** A contract's zod schemas in Fastify's shape, so the zod type provider infers the handler's types. */
export interface RouteSchema<Route extends RouteContract> extends FastifySchema {
  params: Field<Route, "params">;
  querystring: Field<Route, "query">;
  body: Field<Route, "body">;
  response: Route["responses"];
}

export type RouteHandler<Route extends RouteContract> = RouteHandlerMethod<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  RouteGenericInterface,
  ContextConfigDefault,
  RouteSchema<Route>,
  ZodTypeProvider
>;

/** One handler per route of the table, by the route's name. */
export type RouteHandlers<Table extends RouteTable> = { readonly [Name in keyof Table]: RouteHandler<Table[Name]> };

/** Thrown at startup when a route can't be registered; the server then refuses to start. */
export class RouteRegistrationError extends Error {
  override readonly name = "RouteRegistrationError";
}

function isHandler(value: unknown): value is RouteHandlerMethod {
  return typeof value === "function";
}

const methods: readonly string[] = [...safeMethods, ...unsafeMethods];

/** Fails closed on any contract the server can't enforce (domain.md, rule 5). */
function assertRegistrable(name: string, route: RouteContract): void {
  const fail = (reason: string): never => {
    throw new RouteRegistrationError(`Route ${name} (${route.method} ${route.path}) ${reason}`);
  };
  if (!methods.includes(route.method)) fail("has an unknown method");
  if (typeof route.path !== "string" || !route.path.startsWith("/api/v1/")) fail("must have a path under /api/v1/");
  if (!(accessLevels as readonly unknown[]).includes(route.access)) fail("has no valid access level");
  const safe = (safeMethods as readonly string[]).includes(route.method);
  // Read as unknown: the check is for contracts the types would refuse.
  const ssoCallback: unknown = route.ssoCallback;
  if (ssoCallback !== undefined) {
    if (ssoCallback !== true || route.method !== "GET" || route.safe) fail("is an SSO callback, so it must be an unsafe GET");
    if (route.access !== "public") fail("is an SSO callback, which a provider sends the browser to, so it must be public");
  } else if (route.safe !== safe)
    fail(safe ? "is a GET or HEAD route, so it must be marked safe" : "changes state, so it must not be marked safe");
  if (typeof route.recentSignIn !== "boolean") fail("must state whether it needs a recent sign-in");
  if (route.rawBody !== undefined) {
    if (safe) fail("is safe, so it can't take a raw body");
    if (route.body !== undefined) fail("can't take both a JSON body and a raw body");
    if (!Number.isSafeInteger(route.rawBody.maxBytes) || route.rawBody.maxBytes <= 0) fail("must give its raw body a byte limit");
  }
  if (route.access === "public" && route.recentSignIn) fail("is public, so it can't need a recent sign-in");
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route's contract, which the session guard enforces before the handler runs. */
    contract?: RouteContract;
  }
}

/**
 * A raw body is left unread for its handler, which reads it as a stream with its own limit: the
 * app's 1 MiB body limit applies only to bodies Fastify reads. The CSRF checks let a raw media type
 * through only to a route whose contract names it.
 */
function registerRawBodyParsers(app: FastifyInstance, table: readonly RouteContract[]): void {
  for (const mediaType of new Set(table.flatMap((route) => (route.rawBody === undefined ? [] : [route.rawBody.mediaType])))) {
    if (app.hasContentTypeParser(mediaType)) continue;
    app.addContentTypeParser(mediaType, (_request, _payload, done) => {
      done(null, undefined);
    });
  }
}

/**
 * Registers every route of `table`, and only those, each with its contract's schemas and the
 * contract itself in its config, for the session guard: the only way a route reaches the app.
 * Every route needs a handler and every handler a route.
 */
export function registerRoutes<Table extends RouteTable>(app: FastifyInstance, table: Table, handlers: RouteHandlers<Table>): void {
  registerRawBodyParsers(app, Object.values(table));
  const unknown = Object.keys(handlers).filter((name) => !Object.hasOwn(table, name));
  if (unknown.length > 0) throw new RouteRegistrationError(`Handlers for routes not in the table: ${unknown.join(", ")}`);

  for (const [name, route] of Object.entries(table)) {
    assertRegistrable(name, route);
    const handler: unknown = Object.hasOwn(handlers, name) ? (handlers as Record<string, unknown>)[name] : undefined;
    if (!isHandler(handler)) throw new RouteRegistrationError(`Route ${name} has no handler`);
    app.withTypeProvider<ZodTypeProvider>().route({
      method: route.method,
      url: route.path,
      config: { contract: route },
      schema: {
        ...(route.params === undefined ? {} : { params: route.params }),
        ...(route.query === undefined ? {} : { querystring: route.query }),
        ...(route.body === undefined ? {} : { body: route.body }),
        response: route.responses,
      },
      handler,
    });
  }
}
