import { problemTypes, type exportAuditEventsRoute, type listAuditEventsRoute } from "@not-unreachable/contracts";
import { HttpProblem, type RouteHandlers } from "../../http/index.ts";
import { fileTimestamp, systemClock, type Clock } from "../platform/index.ts";
import { InvalidAuditCursorError, type AuditService } from "./service.ts";

export type AuditRoutes = {
  readonly listAuditEvents: typeof listAuditEventsRoute;
  readonly exportAuditEvents: typeof exportAuditEventsRoute;
};

export function createAuditHandlers(audit: AuditService, clock: Clock = systemClock): RouteHandlers<AuditRoutes> {
  return {
    listAuditEvents: async (request) => {
      try {
        return audit.list(request.query);
      } catch (error) {
        if (error instanceof InvalidAuditCursorError) throw new HttpProblem(400, problemTypes.badRequest, error.message);
        throw error;
      }
    },
    exportAuditEvents: async (request, reply) => {
      const csv = audit.exportCsv(request.query);
      // With a non-JSON content type, Fastify sends a string as it is: the zod serializer doesn't run.
      reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="audit-log-${fileTimestamp(clock.now())}.csv"`);
      return csv;
    },
  };
}
