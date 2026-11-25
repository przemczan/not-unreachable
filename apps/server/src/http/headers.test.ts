import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { routes } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newToken } from "../modules/platform/index.ts";
import {
  buildShareLinksTestApp,
  buildTestApp,
  makeTempDir,
  viaProxy,
  writeWebRoot,
  type ShareLinksTestApp,
  type TestApp,
} from "../test-support/index.ts";

/** Headers that vary per response or connection; everything else is compared exactly. */
const varying = new Set(["date", "content-length", "connection", "keep-alive", "etag", "last-modified", "accept-ranges"]);

function stableHeaders(response: LightMyRequestResponse): Record<string, unknown> {
  return Object.fromEntries(Object.entries(response.headers).filter(([name]) => !varying.has(name)));
}

const security = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

describe("security headers (T13)", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let test: TestApp;

  beforeAll(async () => {
    temp = makeTempDir();
    test = await buildTestApp({ webRoot: writeWebRoot(temp.dir) });
  });
  afterAll(async () => {
    await test.close();
    temp.cleanup();
  });

  const get = (url: string, headers: Record<string, string> = viaProxy) => test.app.inject({ method: "GET", url, headers });

  it("an API route", async () => {
    const response = await get("/api/v1/health");
    expect(response.statusCode).toBe(200);
    expect(stableHeaders(response)).toEqual({
      ...security,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
  });

  it("an API route reached through a percent-encoded path", async () => {
    const response = await get("/%61pi/v1/health");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("an API 404", async () => {
    const response = await get("/api/v1/nope");
    expect(response.statusCode).toBe(404);
    expect(stableHeaders(response)).toEqual({
      ...security,
      "cache-control": "no-store",
      "content-type": "application/problem+json; charset=utf-8",
    });
  });

  it("an API error raised before routing (plain http)", async () => {
    const response = await get("/api/v1/health", {});
    expect(response.statusCode).toBe(400);
    expect(stableHeaders(response)).toEqual({
      ...security,
      "cache-control": "no-store",
      "content-type": "application/problem+json; charset=utf-8",
    });
  });

  it("a malformed URL, which Fastify rejects before any hook", async () => {
    const response = await get("/api/v1/%E0%A4%A");
    expect(response.statusCode).toBe(400);
    expect(stableHeaders(response)).toEqual({
      ...security,
      "cache-control": "no-store",
      "content-type": "application/problem+json; charset=utf-8",
    });
  });

  it("index.html, directly and as the SPA fallback", async () => {
    for (const url of ["/index.html", "/files"]) {
      const response = await get(url);
      expect(response.statusCode).toBe(200);
      expect(stableHeaders(response)).toEqual({ ...security, "cache-control": "no-cache", "content-type": "text/html; charset=utf-8" });
    }
  });

  it("the public share page", async () => {
    const response = await get(`/s/${newToken()}`);
    expect(response.statusCode).toBe(200);
    expect(stableHeaders(response)).toEqual({
      ...security,
      "cache-control": "no-cache",
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
    });
  });

  it("a hashed asset", async () => {
    const response = await get("/assets/x.js");
    expect(response.statusCode).toBe(200);
    expect(stableHeaders(response)).toEqual({
      ...security,
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "application/javascript; charset=utf-8",
    });
  });

  it("never Server or X-Powered-By", async () => {
    for (const url of ["/api/v1/health", "/api/v1/nope", "/", "/assets/x.js"]) {
      const response = await get(url);
      expect(response.headers).not.toHaveProperty("server");
      expect(response.headers).not.toHaveProperty("x-powered-by");
    }
  });
});

describe("security headers of downloads (T4, T13)", () => {
  let app: ShareLinksTestApp;

  beforeAll(async () => {
    app = await buildShareLinksTestApp();
    writeFileSync(join(app.homeDir, "page.html"), "<script>alert(1)</script>");
  });
  afterAll(() => app.close());

  /** A download replaces the page CSP with its own sandbox, and is never cached. */
  const download = {
    ...security,
    "cache-control": "no-store",
    "content-type": "application/octet-stream",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  };

  it("a user's download", async () => {
    const response = await app.test.app.inject({
      method: "GET",
      url: `${routes.downloadHomeFile.path}?path=page.html`,
      headers: { ...viaProxy, cookie: app.userCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(stableHeaders(response)).toEqual({
      ...download,
      "content-disposition": `attachment; filename="page.html"; filename*=UTF-8''page.html`,
    });
  });

  it("the admin's download", async () => {
    const response = await app.asAdmin(routes.downloadResourceFile, { params: app.resourceId, query: { path: "single.txt" } });
    expect(response.statusCode).toBe(200);
    expect(stableHeaders(response)).toEqual({
      ...download,
      "content-disposition": `attachment; filename="single.txt"; filename*=UTF-8''single.txt`,
    });
  });

  it("a share link's download", async () => {
    const { token } = await app.createLink({ path: "single.txt" });
    const response = await app.asPublic(routes.downloadShareLinkContent, token);
    expect(response.statusCode).toBe(200);
    expect(stableHeaders(response)).toEqual({
      ...download,
      "content-disposition": `attachment; filename="single.txt"; filename*=UTF-8''single.txt`,
      "x-robots-tag": "noindex, nofollow",
    });
  });
});

describe("HSTS_INCLUDE_SUBDOMAINS", () => {
  it("adds includeSubDomains only when set", async () => {
    const test = await buildTestApp({ config: { hstsIncludeSubdomains: true } });
    try {
      const response = await test.app.inject({ method: "GET", url: "/api/v1/health", headers: viaProxy });
      expect(response.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    } finally {
      await test.close();
    }
  });
});
