import { problemTypes, routes, TUS_VERSION, type RouteContract } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp,
  concretePath,
  corsHeaders,
  expectProblem,
  sameOriginWrite,
  testOrigin,
  viaProxy,
  type TestApp,
} from "../test-support/index.ts";

function expectNoCors(response: LightMyRequestResponse): void {
  expect(corsHeaders(response)).toEqual([]);
}

describe("CSRF checks (T3)", () => {
  let test: TestApp;
  const responses: LightMyRequestResponse[] = [];

  beforeAll(async () => {
    test = await buildTestApp();
  });
  afterAll(async () => {
    for (const response of responses) expectNoCors(response);
    await test.close();
  });

  async function echo(headers: Record<string, string>, payload: string = JSON.stringify({ text: "hi" })): Promise<LightMyRequestResponse> {
    const response = await test.app.inject({ method: "POST", url: "/api/v1/test/echo", headers, payload });
    responses.push(response);
    return response;
  }

  const json = { "content-type": "application/json" };

  it.each([
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["Origin: null", { origin: "null" }],
    ["our origin with another port", { origin: `${testOrigin}:8443` }],
    ["our origin over http", { origin: "http://files.example.com" }],
    ["no Origin and no Sec-Fetch-Site", {}],
    ["no Origin and Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
    ["no Origin and Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
    ["a foreign Origin despite Sec-Fetch-Site: same-origin", { origin: "https://evil.example", "sec-fetch-site": "same-origin" }],
  ])("rejects a POST with %s (403)", async (_name, headers) => {
    expectProblem(await echo({ ...viaProxy, ...json, "x-nu-request": "1", ...headers }), 403, problemTypes.csrfRejected);
  });

  it("rejects our origin without X-NU-Request, or with another value", async () => {
    expectProblem(await echo({ ...viaProxy, ...json, origin: testOrigin }), 403, problemTypes.csrfRejected);
    expectProblem(await echo({ ...viaProxy, ...json, origin: testOrigin, "x-nu-request": "true" }), 403, problemTypes.csrfRejected);
  });

  it("passes our origin with X-NU-Request and a JSON body", async () => {
    const response = await echo({ ...sameOriginWrite, ...json });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "hi" });
  });

  it("passes Sec-Fetch-Site: same-origin without an Origin", async () => {
    const response = await echo({ ...viaProxy, ...json, "sec-fetch-site": "same-origin", "x-nu-request": "1" });
    expect(response.statusCode).toBe(200);
  });

  it("checks unknown routes and other methods too", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await test.app.inject({
        method,
        url: "/api/v1/test/echo",
        headers: { ...viaProxy, origin: "https://evil.example" },
      });
      responses.push(response);
      expectProblem(response, 403, problemTypes.csrfRejected);
    }
  });

  it.each([
    ["text/plain", "hi"],
    ["application/x-www-form-urlencoded", "text=hi"],
    ["multipart/form-data; boundary=x", "--x--"],
    ["application/jsonp", "{}"],
  ])("rejects a %s body (415)", async (contentType, payload) => {
    expectProblem(await echo({ ...sameOriginWrite, "content-type": contentType }, payload), 415, problemTypes.unsupportedMediaType);
  });

  it("accepts application/json with a charset, and a request without a body", async () => {
    expect((await echo({ ...sameOriginWrite, "content-type": "application/json; charset=utf-8" })).statusCode).toBe(200);
    const ping = await test.app.inject({ method: "POST", url: "/api/v1/test/ping", headers: sameOriginWrite });
    responses.push(ping);
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toEqual({ pong: true });
  });

  it("answers an invalid body with a validation problem", async () => {
    expectProblem(await echo({ ...sameOriginWrite, ...json }, JSON.stringify({ text: 1 })), 400, problemTypes.validationFailed);
    expectProblem(await echo({ ...sameOriginWrite, ...json }, "{not json"), 400, problemTypes.badRequest);
  });

  it("gives a CORS preflight no Access-Control-* headers", async () => {
    const response = await test.app.inject({
      method: "OPTIONS",
      url: "/api/v1/test/echo",
      headers: {
        ...viaProxy,
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-nu-request",
      },
    });
    responses.push(response);
    expectNoCors(response);
    expect(response.statusCode).toBe(404);
  });

  it("lets GET through whatever its origin", async () => {
    const response = await test.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { ...viaProxy, origin: "https://evil.example" },
    });
    responses.push(response);
    expect(response.statusCode).toBe(200);
  });
});

/** Every state-changing route of the table, of every access kind (the SSO callback is a GET, guarded by T9 instead). */
const unsafeRoutes = Object.entries<RouteContract>(routes).filter(([, route]) => !route.safe && route.method !== "GET");

describe("CSRF checks over the route table (T3)", () => {
  let test: TestApp;
  let cookie: string;
  const responses: LightMyRequestResponse[] = [];

  beforeAll(async () => {
    test = await buildTestApp();
    cookie = test.startSession(await test.createAdmin());
  });
  afterAll(async () => {
    for (const response of responses) expectNoCors(response);
    await test.close();
  });

  it("covers public, pending, account, user and admin routes, tus chunks among them", () => {
    expect(new Set(unsafeRoutes.map(([, route]) => route.access))).toEqual(
      new Set(["public", "pendingSecondFactor", "account", "user", "admin"]),
    );
    expect(unsafeRoutes.map(([name]) => name)).toEqual(
      expect.arrayContaining(["signIn", "acceptInvitation", "unlockShareLink", "sendUploadChunk", "cancelUpload", "signOut"]),
    );
  });

  const forged: readonly [string, Record<string, string>][] = [
    ["a foreign Origin", { origin: "https://evil.example", "x-nu-request": "1" }],
    ["Origin: null", { origin: "null", "x-nu-request": "1" }],
    ["no Origin and no Sec-Fetch-Site", { "x-nu-request": "1" }],
    ["no Origin and Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site", "x-nu-request": "1" }],
    ["our Origin without X-NU-Request", { origin: testOrigin }],
  ];

  it.each(unsafeRoutes)("%s refuses every forged request with 403 csrf-rejected", async (_name, route) => {
    const rawBody = route.rawBody;
    for (const [, headers] of forged) {
      const response = await test.app.inject({
        method: route.method,
        url: concretePath(route),
        headers: {
          ...viaProxy,
          cookie,
          "tus-resumable": TUS_VERSION,
          "content-type": rawBody?.mediaType ?? "application/json",
          ...headers,
        },
        payload: rawBody === undefined ? "{}" : "x",
      });
      responses.push(response);
      expectProblem(response, 403, problemTypes.csrfRejected);
    }
  });

  it("leaves the session alone after all of them (no sign-out or revocation slipped through)", async () => {
    const response = await test.app.inject({ method: "GET", url: routes.getSession.path, headers: { ...viaProxy, cookie } });
    expect(response.statusCode).toBe(200);
  });

  it("lets the same requests through the CSRF checks with our origin and the header", async () => {
    const response = await test.app.inject({
      method: "POST",
      url: routes.signOut.path,
      headers: { ...sameOriginWrite, cookie: test.startSession(test.createUser()) },
    });
    responses.push(response);
    expect(response.statusCode).toBe(204);
  });
});
