import { problemTypes, type Role, type SessionState } from "@not-unreachable/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock } from "../modules/platform/index.ts";
import { HttpProblem } from "./problems.ts";

/** How long a proof of the password or a factor counts as a recent sign-in (threat model, T2). */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

/** The signed-in account behind a request, as the session guard resolved it from the cookie. */
export interface Caller {
  readonly accountId: string;
  readonly username: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly state: SessionState;
  /** When the password or a factor was last proved in this session. */
  readonly recentSignInAt: Date | null;
}

/** What a handler knows about its caller. */
export interface RequestContext {
  /** The client's address: the socket's, or what a trusted proxy reports. */
  readonly ip: string;
  readonly userAgent: string | null;
  /** The signed-in account; null when the request has no live session. */
  readonly caller: Caller | null;
}

declare module "fastify" {
  interface FastifyRequest {
    requestContext: RequestContext;
  }
}

const callers = new WeakMap<FastifyRequest, Caller>();

/** For the session guard only: the caller it resolved for this request. */
export function setCaller(request: FastifyRequest, caller: Caller): void {
  callers.set(request, caller);
}

export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest("requestContext", {
    getter(this: FastifyRequest): RequestContext {
      const userAgent = this.headers["user-agent"];
      return { ip: this.ip, userAgent: typeof userAgent === "string" ? userAgent : null, caller: callers.get(this) ?? null };
    },
  });
}

/** The caller of a route the guard lets only signed-in accounts reach; fails closed if there is none. */
export function requireCaller(request: FastifyRequest): Caller {
  const caller = request.requestContext.caller;
  if (caller === null) throw new HttpProblem(401, problemTypes.signInRequired);
  return caller;
}

/** Whether the caller proved the password or a factor in the last 10 minutes. */
export function hasRecentSignIn(caller: Pick<Caller, "recentSignInAt">, clock: Clock): boolean {
  return caller.recentSignInAt !== null && clock.now().getTime() - caller.recentSignInAt.getTime() < RECENT_SIGN_IN_MS;
}
