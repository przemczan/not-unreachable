import { defineRoute, routes } from "@not-unreachable/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.ts";
import { absoluteUrl } from "../modules/platform/index.ts";
import {
  buildShareLinksTestApp,
  fakeClock,
  inMemoryServices,
  silentLogger,
  testConfig,
  testOrigin,
  type ShareLinksTestApp,
} from "../test-support/index.ts";

const linkRoute = defineRoute({
  method: "GET",
  path: "/api/v1/test/link",
  access: "public",
  recentSignIn: false,
  safe: true,
  responses: { 200: z.strictObject({ url: z.string(), host: z.string() }) },
});

/** A Host and X-Forwarded-Host of the attacker's, as a request through the trusted proxy may carry them. */
const forgedHost = { host: "evil.example", "x-forwarded-host": "evil2.example", "x-forwarded-proto": "https" };

describe("a forged Host (T15)", () => {
  it("never reaches absolute URLs", async () => {
    const config = testConfig();
    const { services, close } = inMemoryServices();
    const app = await buildApp(config, {
      logger: silentLogger,
      services,
      clock: fakeClock(),
      extraRoutes: {
        table: { link: linkRoute },
        handlers: { link: async (request) => ({ url: absoluteUrl(config, "/sign-in"), host: request.host }) },
      },
    });
    try {
      // From the trusted proxy, so X-Forwarded-Host would be believed by request.host if anything used it.
      const response = await app.inject({ method: "GET", url: "/api/v1/test/link", headers: forgedHost });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ url: "https://files.example.com/sign-in" });

      // From an address that is not a trusted proxy, X-Forwarded-* is not believed at all: not even its https.
      const direct = await app.inject({ method: "GET", url: "/api/v1/test/link", remoteAddress: "203.0.113.5", headers: forgedHost });
      expect(direct.statusCode).toBe(400);
    } finally {
      await app.close();
      close();
    }
  });
});

describe("a forged Host on the routes that hand out links (T15)", () => {
  let app: ShareLinksTestApp;
  beforeAll(async () => {
    app = await buildShareLinksTestApp();
  });
  afterAll(() => app.close());

  it("leaves invitation and share links on PUBLIC_ORIGIN", async () => {
    const invitation = await app.asAdmin(routes.createInvitation, { payload: {}, headers: forgedHost });
    expect(invitation.statusCode).toBe(201);
    expect(z.object({ link: z.string() }).parse(invitation.json()).link.startsWith(`${testOrigin}/invitation/`)).toBe(true);

    const shareLink = await app.asAdmin(routes.createShareLink, {
      payload: { resourceId: app.resourceId, path: "single.txt" },
      headers: forgedHost,
    });
    expect(shareLink.statusCode).toBe(201);
    expect(z.object({ link: z.string() }).parse(shareLink.json()).link.startsWith(`${testOrigin}/s/`)).toBe(true);
    expect(JSON.stringify([invitation.json(), shareLink.json()])).not.toContain("evil");
  });
});
