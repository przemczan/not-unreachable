import { defineRoute, problemMediaType, problemTypes, type RouteTable } from "@not-unreachable/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, api, createApiClient } from "./client.ts";

const testRoutes = {
  getEntry: defineRoute({
    method: "GET",
    path: "/api/v1/home/:folder/entries/:name",
    access: "user",
    recentSignIn: false,
    safe: true,
    params: z.strictObject({ folder: z.string(), name: z.string() }),
    query: z.strictObject({ cursor: z.string().optional(), limit: z.number().optional(), tag: z.array(z.string()).optional() }),
    responses: { 200: z.strictObject({ name: z.string(), size: z.number() }) },
  }),
  createInvitation: defineRoute({
    method: "POST",
    path: "/api/v1/admin/invitations",
    access: "admin",
    recentSignIn: true,
    safe: false,
    body: z.strictObject({ email: z.string() }),
    responses: { 201: z.strictObject({ id: z.string() }), 204: z.undefined() },
  }),
} as const satisfies RouteTable;

const call = createApiClient(testRoutes);

function json(status: number, body: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": contentType } });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof stubFetch>): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  if (typeof url !== "string" || init === undefined) throw new Error("fetch was not called with a URL and init.");
  return { url, init, headers: new Headers(init.headers) };
}

async function apiErrorOf(promise: Promise<unknown>): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ApiError)) throw new Error("Expected an ApiError.", { cause: error });
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("sends X-NU-Request on every request, same-origin credentials and a relative URL", async () => {
    const fetchMock = stubFetch(json(200, { status: "ok" }));

    await expect(api("health")).resolves.toEqual({ status: "ok" });

    const { url, init, headers } = requestOf(fetchMock);
    expect(url).toBe("/api/v1/health");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("X-NU-Request")).toBe("1");
    expect(headers.has("Content-Type")).toBe(false);
    expect(init.body).toBeUndefined();
  });

  it("encodes path params and builds the query string", async () => {
    const fetchMock = stubFetch(json(200, { name: "a b", size: 3 }));

    await call("getEntry", {
      params: { folder: "../etc", name: "a b/c?d#e" },
      query: { cursor: "x&y=z", limit: 50, tag: ["one", "two"] },
    });

    expect(requestOf(fetchMock).url).toBe("/api/v1/home/..%2Fetc/entries/a%20b%2Fc%3Fd%23e?cursor=x%26y%3Dz&limit=50&tag=one&tag=two");
  });

  it("leaves out undefined query values and the ? when nothing is left", async () => {
    const fetchMock = stubFetch(json(200, { name: "n", size: 1 }));

    await call("getEntry", { params: { folder: "f", name: "n" }, query: { cursor: undefined } });

    expect(requestOf(fetchMock).url).toBe("/api/v1/home/f/entries/n");
  });

  it("sends a JSON body with Content-Type and parses the response for its status", async () => {
    const fetchMock = stubFetch(json(201, { id: "inv_1" }));

    const created = await call("createInvitation", { body: { email: "a@example.com" } });

    expect(created).toEqual({ id: "inv_1" });
    const { init, headers } = requestOf(fetchMock);
    expect(init.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-NU-Request")).toBe("1");
    expect(init.body).toBe(JSON.stringify({ email: "a@example.com" }));
  });

  it("accepts an empty body when the status's schema allows it", async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(call("createInvitation", { body: { email: "a@example.com" } })).resolves.toBeUndefined();
  });

  it("rejects a success body that does not match the route's schema", async () => {
    stubFetch(json(200, { status: "broken" }));

    await expect(api("health")).rejects.toThrow(z.ZodError);
  });

  it("rejects a success status the route does not declare", async () => {
    stubFetch(json(202, { status: "ok" }));

    await expect(api("health")).rejects.toThrow(/Unexpected status 202/);
  });

  it("turns application/problem+json into a typed ApiError", async () => {
    const problem = { type: problemTypes.rateLimited, title: "Too many requests", status: 429, detail: "Try again in a minute." };
    stubFetch(json(429, problem, `${problemMediaType}; charset=utf-8`));

    const apiError = await apiErrorOf(api("health"));

    expect(apiError.problem).toEqual(problem);
    expect(apiError.status).toBe(429);
    expect(apiError.type).toBe(problemTypes.rateLimited);
    expect(apiError.message).toBe("Try again in a minute.");
    expect(apiError.retryAfterSeconds).toBeUndefined();
  });

  it("reads Retry-After in seconds onto the ApiError", async () => {
    const problem = { type: problemTypes.tooManyAttempts, title: "Too many attempts", status: 429 };
    stubFetch(new Response(JSON.stringify(problem), { status: 429, headers: { "Content-Type": problemMediaType, "Retry-After": "900" } }));

    expect((await apiErrorOf(api("health"))).retryAfterSeconds).toBe(900);
  });

  it("turns an error without a valid problem body into a generic ApiError", async () => {
    stubFetch(
      new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway", headers: { "Content-Type": "text/html" } }),
    );

    const apiError = await apiErrorOf(api("health"));

    expect(apiError.problem).toEqual({ type: "about:blank", title: "Bad Gateway", status: 502 });
  });
});
