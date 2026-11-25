import { problemTypes, routes, type AuditEvent, type AuditPage } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, expectProblem, type TestApp } from "../../test-support/index.ts";
import { callRoute } from "../../test-support/sessions.ts";
import { auditCsvHeader } from "./service.ts";

describe("the audit log over HTTP", () => {
  let test: TestApp;
  let cookie: string;

  beforeEach(async () => {
    test = await buildTestApp();
    await test.createAdmin();
    cookie = await test.signIn("admin");
    for (let index = 0; index < 5; index += 1) {
      test.clock.advance(1000);
      test.services.audit.record({
        action: "system.started",
        actor: { kind: "system" },
        outcome: "succeeded",
        details: { version: `1.0.${index}` },
      });
    }
  });
  afterEach(() => test.close());

  const page = (query: string) => callRoute(test, routes.listAuditEvents, { cookie, query });

  it("pages through every event, newest first, with the cursor", async () => {
    const seen: AuditEvent[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await page(`action=system.started&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(response.statusCode).toBe(200);
      const body: AuditPage = response.json();
      seen.push(...body.events);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(seen.map((event) => event.details["version"])).toEqual(["1.0.4", "1.0.3", "1.0.2", "1.0.1", "1.0.0"]);
  });

  it("filters, and answers 400 for a cursor it didn't make", async () => {
    const response = await page("actorKind=account");
    const actions = response.json<AuditPage>().events.map((event) => event.action);
    expect(actions).toContain("sign-in.succeeded");
    expect(actions).not.toContain("system.started");
    expectProblem(await page("cursor=not-a-cursor"), 400, problemTypes.badRequest);
  });

  it("exports the filtered events as a CSV attachment", async () => {
    const response = await callRoute(test, routes.exportAuditEvents, { cookie, query: "action=system.started" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="audit-log-\d{8}T\d{9}Z\.csv"$/);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    const lines = response.body.trimEnd().split(/\r?\n/);
    expect(lines[0]).toBe(auditCsvHeader.join(","));
    expect(lines).toHaveLength(6);
    expect(response.body).not.toContain("sign-in.succeeded");
  });

  it("is the admin's only", async () => {
    const userCookie = test.startSession(test.createUser());
    for (const route of [routes.listAuditEvents, routes.exportAuditEvents]) {
      expectProblem(await callRoute(test, route, { cookie: userCookie }), 403, problemTypes.forbidden);
      expectProblem(await callRoute(test, route), 401, problemTypes.signInRequired);
    }
  });
});
