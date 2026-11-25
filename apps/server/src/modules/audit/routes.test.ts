import { exportAuditEventsRoute, listAuditEventsRoute, routes } from "@not-unreachable/contracts";
import Fastify, { type ContextConfigDefault, type FastifyInstance, type RouteGenericInterface } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpProblem, type RouteSchema } from "../../http/index.ts";
import { fakeClock, makeTempDir, migratedMemoryDatabase, silentLogger } from "../../test-support/index.ts";
import type { Database } from "../platform/index.ts";
import { createSettingsService } from "../settings/index.ts";
import { createAuditHandlers, createAuditService, type AuditService } from "./index.ts";

type ListRoute = typeof listAuditEventsRoute;
type ExportRoute = typeof exportAuditEventsRoute;

/** The routes alone, with the app's zod compilers; the session guard is the app's, tested with it. */
function registerAuditRoutes(app: FastifyInstance, handlers: ReturnType<typeof createAuditHandlers>): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route<RouteGenericInterface, ContextConfigDefault, RouteSchema<ListRoute>>({
    method: listAuditEventsRoute.method,
    url: listAuditEventsRoute.path,
    schema: { params: undefined, querystring: listAuditEventsRoute.query, body: undefined, response: listAuditEventsRoute.responses },
    handler: handlers.listAuditEvents,
  });
  typed.route<RouteGenericInterface, ContextConfigDefault, RouteSchema<ExportRoute>>({
    method: exportAuditEventsRoute.method,
    url: exportAuditEventsRoute.path,
    schema: { params: undefined, querystring: exportAuditEventsRoute.query, body: undefined, response: exportAuditEventsRoute.responses },
    handler: handlers.exportAuditEvents,
  });
}

describe("audit route handlers", () => {
  const clock = fakeClock("2026-11-24T10:15:00.123Z");
  let temp: ReturnType<typeof makeTempDir>;
  let database: Database;
  let audit: AuditService;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = makeTempDir();
    database = migratedMemoryDatabase(temp.dir, clock);
    const settings = createSettingsService({ db: database.db, clock, logger: silentLogger });
    audit = createAuditService({ db: database.db, clock, logger: silentLogger, settings });
    const handlers = createAuditHandlers(audit, clock);
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof HttpProblem) return reply.code(error.status).send(error.toProblem());
      return reply.code(500).send({ unexpected: String(error) });
    });
    registerAuditRoutes(app, handlers);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    database.sqlite.close();
    temp.cleanup();
  });

  it("lists a page", async () => {
    audit.record({ action: "sign-out", actor: { kind: "anonymous" }, outcome: "succeeded", details: {} });
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/audit-events?limit=1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [expect.objectContaining({ action: "sign-out" })], nextCursor: null });
  });

  it("answers 400 for a bad cursor", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/audit-events?cursor=nope" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ type: "/problems/bad-request", status: 400 });
  });

  it("sends the CSV as it is, as an attachment", async () => {
    audit.record({ action: "system.started", actor: { kind: "system" }, outcome: "succeeded", details: { version: "=1" } });
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/audit-events/export.csv?actorKind=system" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="audit-log-20261124T101500123Z.csv"');
    expect(response.body).toBe(audit.exportCsv({ actorKind: "system" }));
    expect(response.body.startsWith("at,actor kind,")).toBe(true);
    expect(response.body).toContain('"{""version"":""=1""}"');
  });
});

describe("the audit log's routes (T12)", () => {
  it("only read: no route of the table changes or deletes an event", () => {
    const auditRoutes = Object.values(routes).filter((route) => route.path.includes("audit"));
    expect(auditRoutes.map((route) => `${route.method} ${route.path}`).toSorted()).toEqual([
      "GET /api/v1/admin/audit-events",
      "GET /api/v1/admin/audit-events/export.csv",
    ]);
    expect(auditRoutes.every((route) => route.safe && route.access === "admin")).toBe(true);
  });
});
