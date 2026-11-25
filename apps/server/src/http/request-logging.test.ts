import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newToken } from "../modules/platform/index.ts";
import { buildTestApp, makeTempDir, sameOriginWrite, viaProxy, writeWebRoot, type TestApp } from "../test-support/index.ts";

/**
 * The real app's request log (journald) never holds a bearer token from a URL (threat model, T8,
 * T12; ASVS V14.2.1, V16.2.5): share links, invitation and re-link links, and the SSO callback's
 * `code` and `state`, whether the request reaches an API route or the SPA's page.
 */
describe("the request log", () => {
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

  const loggedUrls = (): string[] =>
    test
      .logs()
      .map((line) => line["req"])
      .filter((req): req is { url: string } => typeof req === "object" && req !== null && "url" in req && typeof req.url === "string")
      .map((req) => req.url);

  it.each([
    ["GET", "/s/TOKEN"],
    ["GET", "/api/v1/public/share-links/TOKEN/entries?path=a"],
    ["GET", "/invitation/TOKEN"],
    ["GET", "/relink/TOKEN?error=sign-in-failed"],
    ["GET", "/api/v1/invitations/TOKEN"],
    ["POST", "/api/v1/invitations/TOKEN/accept"],
    ["GET", "/api/v1/relink/TOKEN"],
    ["POST", "/api/v1/relink/TOKEN/start"],
    ["GET", "/%69nvitation/TOKEN"],
    ["GET", "/api/v1/sso/01900000-0000-7000-8000-000000000000/callback?code=TOKEN&state=TOKEN"],
  ] as const)("%s %s keeps no token", async (method, template) => {
    const token = newToken();
    const url = template.replaceAll("TOKEN", token);
    await test.app.inject({ method, url, headers: method === "GET" ? viaProxy : sameOriginWrite });
    const urls = loggedUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(JSON.stringify(test.logs())).not.toContain(token);
  });
});
