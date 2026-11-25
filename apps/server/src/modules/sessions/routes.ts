import {
  problemTypes,
  type listSessionsRoute,
  type revokeOtherSessionsRoute,
  type revokeSessionRoute,
  type SessionSummary,
} from "@not-unreachable/contracts";
import { HttpProblem, requireCaller, type Caller, type RouteHandlers } from "../../http/index.ts";
import { actorOf } from "../audit/index.ts";
import { clearedSessionCookie } from "./cookie.ts";
import type { LiveSession, SessionsService } from "./service.ts";

export type SessionsRoutes = {
  readonly listSessions: typeof listSessionsRoute;
  readonly revokeSession: typeof revokeSessionRoute;
  readonly revokeOtherSessions: typeof revokeOtherSessionsRoute;
};

function toSummary(session: LiveSession, caller: Caller): SessionSummary {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    ip: session.ip,
    userAgent: session.userAgent,
    current: session.id === caller.sessionId,
  };
}

export function createSessionsHandlers(sessions: SessionsService): RouteHandlers<SessionsRoutes> {
  return {
    listSessions: async (request) => {
      const caller = requireCaller(request);
      return { sessions: sessions.listLive(caller.accountId).map((session) => toSummary(session, caller)) };
    },

    revokeSession: async (request, reply) => {
      const caller = requireCaller(request);
      const context = { actor: actorOf(caller), origin: request.requestContext };
      // Another account's session answers as an unknown one.
      if (!sessions.revoke(caller.accountId, request.params.id, "signed-out-elsewhere", context)) {
        throw new HttpProblem(404, problemTypes.notFound);
      }
      if (request.params.id === caller.sessionId) reply.header("set-cookie", clearedSessionCookie());
      return reply.code(204).send();
    },

    revokeOtherSessions: async (request) => {
      const caller = requireCaller(request);
      const context = { actor: actorOf(caller), origin: request.requestContext };
      return { revoked: sessions.revokeOthers(caller.accountId, caller.sessionId, "signed-out-others", context) };
    },
  };
}
