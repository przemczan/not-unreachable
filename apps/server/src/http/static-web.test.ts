import { problemTypes } from "@not-unreachable/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, expectProblem, makeTempDir, sameOriginWrite, viaProxy, writeWebRoot, type TestApp } from "../test-support/index.ts";

describe("the SPA and its static files", () => {
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

  const get = (url: string, method: "GET" | "HEAD" = "GET") => test.app.inject({ method, url, headers: viaProxy });

  it.each(["/", "/admin", "/files", "/sign-in", "/files/a/b", "/files/a%20b?x=1", "/assets"])("answers %s with index.html", async (url) => {
    const response = await get(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.body).toContain('<script type="module" src="/assets/x.js">');
  });

  it("answers HEAD on a client route too", async () => {
    const response = await get("/files", "HEAD");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("serves hashed assets as immutable and other files as no-cache", async () => {
    const asset = await get("/assets/x.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.body).toBe("export {};\n");
    const robots = await get("/robots.txt");
    expect(robots.statusCode).toBe(200);
    expect(robots.headers["cache-control"]).toBe("no-cache");
  });

  it("never falls back for /api, and answers a missing asset with 404", async () => {
    for (const url of ["/api/v1/nope", "/api", "/api/", "/api/v1/health/x"]) expectProblem(await get(url), 404, problemTypes.notFound);
    expectProblem(await get("/assets/gone-1234.js"), 404, problemTypes.notFound);
  });

  it("serves no dotfiles and no directory listings", async () => {
    const dotfile = await get("/.secret");
    expect(dotfile.body).not.toContain("do not serve");
    const listing = await get("/assets/");
    expectProblem(listing, 404, problemTypes.notFound);
    expect(listing.body).not.toContain("x.js");
  });

  it("answers non-GET requests outside /api with a 404 problem", async () => {
    const response = await test.app.inject({ method: "POST", url: "/files", headers: sameOriginWrite });
    expectProblem(response, 404, problemTypes.notFound);
  });

  it("doesn't rate-limit static files or the SPA fallback", async () => {
    test.settings.set("globalRateLimit", { max: 1, timeWindowSeconds: 60 }, null);
    const client = { ...viaProxy, "x-forwarded-for": "198.51.100.50" };
    for (let i = 0; i < 3; i++) {
      expect((await test.app.inject({ method: "GET", url: "/files", headers: client })).statusCode).toBe(200);
      expect((await test.app.inject({ method: "GET", url: "/assets/x.js", headers: client })).statusCode).toBe(200);
    }
    expect((await test.app.inject({ method: "GET", url: "/api/v1/health", headers: client })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/api/v1/health", headers: client })).statusCode).toBe(429);
  });
});

describe("without a web root", () => {
  it("answers every unknown path with a 404 problem", async () => {
    const test = await buildTestApp();
    try {
      expectProblem(await test.app.inject({ method: "GET", url: "/files", headers: viaProxy }), 404, problemTypes.notFound);
    } finally {
      await test.close();
    }
  });
});
