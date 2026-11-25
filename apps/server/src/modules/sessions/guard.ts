import { problemTypes, type RouteContract } from "@not-unreachable/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasRecentSignIn, HttpProblem, setCaller, type Caller } from "../../http/index.ts";
import type { Clock } from "../platform/index.ts";
import { readSessionToken } from "./cookie.ts";
import type { LiveSession, SessionsService } from "./service.ts";

export function toCaller(session: LiveSession): Caller {
  return {
    accountId: session.account.id,
    username: session.account.username,
    role: session.account.role,
    sessionId: session.id,
    state: session.state,
    recentSignInAt: session.recentSignInAt === null ? null : new Date(session.recentSignInAt),
  };
}

/** Throws the problem a caller gets for a route it may not call; returns when it may. */
export function enforceContract(route: Pick<RouteContract, "access" | "recentSignIn">, caller: Caller | null, clock: Clock): void {
  if (route.access === "public") return;
  if (caller === null) throw new HttpProblem(401, problemTypes.signInRequired);
  if (route.access === "pendingSecondFactor") return;
  if (caller.state !== "active") throw new HttpProblem(403, problemTypes.forbidden, "Finish signing in first.");
  if (route.access !== "account" && route.access !== caller.role) throw new HttpProblem(403, problemTypes.forbidden);
  if (route.recentSignIn && !hasRecentSignIn(caller, clock)) {
    throw new HttpProblem(403, problemTypes.recentSignInRequired, "Confirm your password to continue.");
  }
}

function resolveCaller(request: FastifyRequest, sessions: SessionsService): Caller | null {
  const token = readSessionToken(request.headers.cookie);
  const session = token === undefined ? undefined : sessions.resolve(token);
  if (session === undefined) return null;
  const caller = toCaller(session);
  setCaller(request, caller);
  return caller;
}

/**
 * The guard (domain.md, rule 5): before any handler, it resolves the caller's session from the
 * cookie into the request context and enforces the route contract's access and recent sign-in.
 * Requests that reach no route of the table (404s, static files) carry no contract and pass.
 */
export function registerSessionGuard(app: FastifyInstance, sessions: SessionsService, clock: Clock): void {
  app.addHook("onRequest", async (request) => {
    const route = request.routeOptions.config.contract;
    if (route === undefined) return;
    enforceContract(route, resolveCaller(request, sessions), clock);
  });
}
