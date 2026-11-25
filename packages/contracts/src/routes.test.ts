import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accessLevels, homeUploadMetadataSchema, routes, safeMethods, type RouteContract } from "./index.ts";

const table: [string, RouteContract][] = Object.entries(routes);

describe("the route table", () => {
  it.each(table)("%s states a valid access level", (_name, route) => {
    expect(accessLevels).toContain(route.access);
    expect(typeof route.recentSignIn).toBe("boolean");
  });

  it.each(table.filter(([, route]) => route.ssoCallback !== true))("%s is safe exactly when it is a GET or HEAD", (_name, route) => {
    expect(route.safe).toBe((safeMethods as readonly string[]).includes(route.method));
  });

  it("has the SSO callback as its only GET that changes state", () => {
    const unsafeGets = table.filter(([, route]) => route.method === "GET" && !route.safe);
    expect(unsafeGets.map(([name, route]) => [name, route.path, route.ssoCallback])).toEqual([
      ["ssoCallback", "/api/v1/sso/:id/callback", true],
    ]);
  });

  it.each(table)("%s lives under /api/v1/", (_name, route) => {
    // Lower-case segments; a parameter may be camelCase (`:resourceId`).
    expect(route.path).toMatch(/^\/api\/v1(\/([a-z0-9-]+|:[a-z][A-Za-z]*))+(\.[a-z]+)?$/);
  });

  it.each(table.filter(([, route]) => route.path.startsWith("/api/v1/admin/")))("%s is for the admin only", (_name, route) => {
    expect(route.access).toBe("admin");
  });

  it("has admin routes to check", () => {
    expect(table.some(([, route]) => route.path.startsWith("/api/v1/admin/"))).toBe(true);
  });

  // Threat model, T5 step 8: a user's root is their home, found from the session, never a resource.
  it.each(table.filter(([, route]) => route.access === "user"))("%s takes no resource id", (_name, route) => {
    const keys = [route.params, route.query, route.body].flatMap((schema) =>
      schema instanceof z.ZodObject ? Object.keys(schema.shape) : [],
    );
    expect(keys).not.toContain("resourceId");
    expect(route.path).not.toContain("resource");
  });

  it("refuses a resource id in a user's upload metadata", () => {
    expect(homeUploadMetadataSchema.safeParse({ name: "a.txt", resourceId: "0190e0c4-7a5b-7c3d-8e9f-0a1b2c3d4e5f" }).success).toBe(false);
  });

  it("gives a raw body only to unsafe routes without a JSON body", () => {
    for (const [, route] of table.filter(([, candidate]) => candidate.rawBody !== undefined)) {
      expect(route.safe).toBe(false);
      expect(route.body).toBeUndefined();
    }
  });

  it("has one route per method and path", () => {
    const keys = table.map(([, route]) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
