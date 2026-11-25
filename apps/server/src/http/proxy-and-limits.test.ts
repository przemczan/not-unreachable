import { problemTypes } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODY_LIMIT_BYTES } from "../app.ts";
import { buildTestApp, expectProblem, SECRET_FAILURE, sameOriginWrite, viaProxy, type TestApp } from "../test-support/index.ts";
import { rateLimitKey } from "./rate-limit.ts";

describe("trusted proxies and https", () => {
  let test: TestApp;
  beforeEach(async () => {
    test = await buildTestApp();
  });
  afterEach(() => test.close());

  const caller = (remoteAddress: string, headers: Record<string, string>) =>
    test.app.inject({ method: "GET", url: "/api/v1/test/caller", remoteAddress, headers });

  it("ignores forwarded headers from an untrusted address", async () => {
    const response = await caller("203.0.113.5", { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https" });
    // The forged X-Forwarded-Proto is ignored, so the request counts as plain http.
    expectProblem(response, 400, problemTypes.httpsRequired);
  });

  it("believes forwarded headers from a trusted proxy", async () => {
    const response = await caller("127.0.0.1", { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: "198.51.100.7", protocol: "https", caller: null });
  });

  it("answers plain http with 400 https-required", async () => {
    expectProblem(await caller("127.0.0.1", {}), 400, problemTypes.httpsRequired);
    expectProblem(await caller("127.0.0.1", { "x-forwarded-proto": "http" }), 400, problemTypes.httpsRequired);
  });
});

describe("https in development (PUBLIC_ORIGIN http://localhost)", () => {
  let test: TestApp;
  beforeEach(async () => {
    test = await buildTestApp({ config: { publicOrigin: "http://localhost:8481" } });
  });
  afterEach(() => test.close());

  const caller = (remoteAddress: string, headers: Record<string, string> = {}) =>
    test.app.inject({ method: "GET", url: "/api/v1/test/caller", remoteAddress, headers });

  it("allows plain http from loopback", async () => {
    expect((await caller("127.0.0.1")).json()).toEqual({ ip: "127.0.0.1", protocol: "http", caller: null });
    expect((await caller("::1")).statusCode).toBe(200);
  });

  it("still refuses plain http from anywhere else", async () => {
    expectProblem(await caller("192.0.2.1"), 400, problemTypes.httpsRequired);
    expectProblem(await caller("127.0.0.1", { "x-forwarded-for": "198.51.100.7" }), 400, problemTypes.httpsRequired);
  });
});

describe("global rate limit (T11)", () => {
  let test: TestApp;
  beforeEach(async () => {
    test = await buildTestApp();
  });
  afterEach(() => test.close());

  const health = (clientIp: string) =>
    test.app.inject({ method: "GET", url: "/api/v1/health", headers: { ...viaProxy, "x-forwarded-for": clientIp } });

  it("answers the request after the limit with 429, Retry-After and a problem; a changed setting applies", async () => {
    test.settings.set("globalRateLimit", { max: 3, timeWindowSeconds: 60 }, null);
    for (let i = 0; i < 3; i++) expect((await health("198.51.100.1")).statusCode).toBe(200);
    const rejected = await health("198.51.100.1");
    expectProblem(rejected, 429, problemTypes.rateLimited);
    expect(rejected.headers["retry-after"]).toBe("60");
    expect(rejected.headers["cache-control"]).toBe("no-store");
    expect(rejected.headers).not.toHaveProperty("x-ratelimit-limit");
    // Another client has its own bucket, and unknown API routes count too.
    expect((await health("198.51.100.2")).statusCode).toBe(200);
    const notFound = () =>
      test.app.inject({ method: "GET", url: "/api/v1/nope", headers: { ...viaProxy, "x-forwarded-for": "198.51.100.2" } });
    expect((await notFound()).statusCode).toBe(404);
    expect((await notFound()).statusCode).toBe(404);
    expect((await notFound()).statusCode).toBe(429);
  });

  it("counts API routes reached through a percent-encoded path", async () => {
    test.settings.set("globalRateLimit", { max: 1, timeWindowSeconds: 60 }, null);
    const encoded = () =>
      test.app.inject({ method: "GET", url: "/%61pi/v1/health", headers: { ...viaProxy, "x-forwarded-for": "198.51.100.3" } });
    expect((await encoded()).statusCode).toBe(200);
    expectProblem(await encoded(), 429, problemTypes.rateLimited);
  });

  it("groups IPv6 clients by /64 and maps IPv4-mapped addresses to IPv4", async () => {
    test.settings.set("globalRateLimit", { max: 2, timeWindowSeconds: 60 }, null);
    expect((await health("2001:db8:1:2::1")).statusCode).toBe(200);
    expect((await health("2001:db8:1:2:ffff:ffff:ffff:fffe")).statusCode).toBe(200);
    expect((await health("2001:db8:1:2:abcd::9")).statusCode).toBe(429);
    expect((await health("2001:db8:1:3::1")).statusCode).toBe(200);
  });

  it("normalises keys", () => {
    expect(rateLimitKey("198.51.100.9")).toBe("198.51.100.9");
    expect(rateLimitKey("::ffff:198.51.100.9")).toBe("198.51.100.9");
    expect(rateLimitKey("2001:db8:1:2:ffff::1")).toBe(rateLimitKey("2001:DB8:1:2::7"));
    expect(rateLimitKey("2001:db8:1:2::1")).not.toBe(rateLimitKey("2001:db8:1:3::1"));
  });
});

describe("body limit and errors", () => {
  let test: TestApp;
  beforeEach(async () => {
    test = await buildTestApp();
  });
  afterEach(() => test.close());

  it("answers a body over 1 MiB with 413", async () => {
    const payload = JSON.stringify({ text: "x".repeat(BODY_LIMIT_BYTES) });
    const response = await test.app.inject({
      method: "POST",
      url: "/api/v1/test/echo",
      headers: { ...sameOriginWrite, "content-type": "application/json" },
      payload,
    });
    expectProblem(response, 413, problemTypes.payloadTooLarge);
  });

  it("answers a thrown error with a bare 500 and logs it", async () => {
    const response = await test.app.inject({ method: "GET", url: "/api/v1/test/boom", headers: viaProxy });
    const body = expectProblem(response, 500, problemTypes.internalError);
    expect(body).toEqual({ type: problemTypes.internalError, title: "Internal server error", status: 500 });
    expect(response.body).not.toContain("secret.sqlite");
    expect(response.body).not.toContain("stack");
    expect(JSON.stringify(test.logs())).toContain(SECRET_FAILURE);
  });
});
