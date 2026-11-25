import { defineRoute, routes, type RouteContract, type RouteTable } from "@not-unreachable/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.ts";
import { allowFromUiOf } from "../modules/resources/index.ts";
import {
  fakeClock,
  inMemoryServices,
  silentLogger,
  testConfig,
  testHandlers,
  testRoutes,
  testUpdatesOptions,
} from "../test-support/index.ts";
import { RouteRegistrationError, type RouteHandlers } from "./routes.ts";

const publicPost = defineRoute({
  method: "POST",
  path: "/api/v1/test/write",
  access: "public",
  recentSignIn: false,
  safe: false,
  responses: { 200: z.strictObject({}) },
});

const { services, close } = inMemoryServices();

const has = (app: { hasRoute(route: { method: string; url: string }): boolean }, route: RouteContract): boolean =>
  app.hasRoute({ method: route.method, url: route.path });
afterAll(close);

/** Builds the app with one extra route whose contract the type system would refuse. */
function buildWith(route: Record<string, unknown>, handlers: Record<string, unknown> = { extra: async () => ({}) }) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately invalid contracts, which the types would refuse.
  const table = { extra: route as unknown as RouteContract } satisfies RouteTable;
  return buildApp(testConfig(), {
    logger: silentLogger,
    services,
    clock: fakeClock(),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately missing or stray handlers.
    extraRoutes: { table, handlers: handlers as unknown as RouteHandlers<typeof table> },
  });
}

describe("registerRoutes", () => {
  it("registers the contract table and extra routes", async () => {
    const app = await buildApp(testConfig(), {
      logger: silentLogger,
      services,
      clock: fakeClock(),
      extraRoutes: { table: testRoutes, handlers: testHandlers },
    });
    await app.ready();
    expect(app.hasRoute({ method: "GET", url: routes.health.path })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: testRoutes.testEcho.path })).toBe(true);
    await app.close();
  });

  it("registers allowFolder only while ALLOW_FOLDERS_FROM_UI is on, and every other route always", async () => {
    const { allowFolder, checkForUpdates: _checkForUpdates, installUpdate: _installUpdate, ...always } = routes;
    const off = await buildApp(testConfig(), { logger: silentLogger, services, clock: fakeClock() });
    await off.ready();
    for (const route of Object.values(always)) expect(off.hasRoute({ method: route.method, url: route.path })).toBe(true);
    expect(off.hasRoute({ method: allowFolder.method, url: allowFolder.path })).toBe(false);
    await off.close();

    // The services must have been made with the switch on too: the route never runs without them.
    const config = testConfig({ allowFoldersFromUi: true });
    await expect(buildApp(config, { logger: silentLogger, services, clock: fakeClock() })).rejects.toThrow(/ALLOW_FOLDERS_FROM_UI is on/);
    const on = inMemoryServices(fakeClock(), allowFromUiOf(config));
    try {
      const app = await buildApp(config, { logger: silentLogger, services: on.services, clock: fakeClock() });
      await app.ready();
      expect(app.hasRoute({ method: allowFolder.method, url: allowFolder.path })).toBe(true);
      await app.close();
    } finally {
      on.close();
    }
  });

  it("registers checkForUpdates only while UPDATE_CHECK is on, and installUpdate only while UPDATE_FROM_UI is on", async () => {
    const { checkForUpdates, installUpdate, getUpdates } = routes;

    const off = await buildApp(testConfig(), { logger: silentLogger, services, clock: fakeClock() });
    await off.ready();
    expect([has(off, getUpdates), has(off, checkForUpdates), has(off, installUpdate)]).toEqual([true, false, false]);
    await off.close();

    // The services must have been made with the same switches.
    await expect(buildApp(testConfig({ updateFromUi: true }), { logger: silentLogger, services, clock: fakeClock() })).rejects.toThrow(
      /UPDATE_CHECK or UPDATE_FROM_UI/,
    );
    for (const [check, fromUi] of [
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const on = inMemoryServices(fakeClock(), {}, testUpdatesOptions({ check, fromUi }));
      try {
        const app = await buildApp(testConfig({ updateCheck: check, updateFromUi: fromUi }), {
          logger: silentLogger,
          services: on.services,
          clock: fakeClock(),
        });
        await app.ready();
        expect([has(app, getUpdates), has(app, checkForUpdates), has(app, installUpdate)]).toEqual([true, check, fromUi]);
        await app.close();
      } finally {
        on.close();
      }
    }
  });

  it.each(["account", "user", "admin", "pendingSecondFactor"])("registers a %s route, which the session guard enforces", async (access) => {
    const app = await buildWith({ ...publicPost, access, recentSignIn: access !== "pendingSecondFactor" });
    await app.ready();
    expect(app.hasRoute({ method: "POST", url: publicPost.path })).toBe(true);
    await app.close();
  });

  it("refuses a public route that asks for a recent sign-in, and one that doesn't say", async () => {
    await expect(buildWith({ ...publicPost, recentSignIn: true })).rejects.toThrow(/is public, so it can't need a recent sign-in/);
    const { recentSignIn: _recentSignIn, ...withoutRecentSignIn } = publicPost;
    await expect(buildWith(withoutRecentSignIn)).rejects.toThrow(/must state whether it needs a recent sign-in/);
  });

  it("refuses a route without a valid access level", async () => {
    const { access: _access, ...withoutAccess } = publicPost;
    await expect(buildWith(withoutAccess)).rejects.toThrow(/no valid access level/);
    await expect(buildWith({ ...publicPost, access: "everyone" })).rejects.toThrow(/no valid access level/);
  });

  it("refuses a GET or HEAD route not marked safe, and an unsafe method marked safe", async () => {
    await expect(buildWith({ ...publicPost, method: "GET", safe: false })).rejects.toThrow(/must be marked safe/);
    await expect(buildWith({ ...publicPost, method: "HEAD" })).rejects.toThrow(/must be marked safe/);
    await expect(buildWith({ ...publicPost, safe: true })).rejects.toThrow(/must not be marked safe/);
  });

  it("registers a public SSO callback, the one GET that is not safe", async () => {
    const app = await buildWith({ ...publicPost, method: "GET", safe: false, ssoCallback: true });
    await app.ready();
    expect(app.hasRoute({ method: "GET", url: publicPost.path })).toBe(true);
    await app.close();
  });

  it("refuses an SSO callback that is not a public, unsafe GET", async () => {
    const callback = { ...publicPost, method: "GET", safe: false, ssoCallback: true };
    await expect(buildWith({ ...callback, access: "account" })).rejects.toThrow(/so it must be public/);
    await expect(buildWith({ ...callback, method: "POST" })).rejects.toThrow(/must be an unsafe GET/);
    await expect(buildWith({ ...callback, safe: true })).rejects.toThrow(/must be an unsafe GET/);
    await expect(buildWith({ ...callback, ssoCallback: false })).rejects.toThrow(/must be an unsafe GET/);
  });

  it("refuses an unknown method or a path outside /api/v1/", async () => {
    await expect(buildWith({ ...publicPost, method: "OPTIONS" })).rejects.toThrow(/unknown method/);
    await expect(buildWith({ ...publicPost, path: "/admin/x" })).rejects.toThrow(/under \/api\/v1\//);
  });

  it("refuses a route without a handler, and a handler without a route", async () => {
    await expect(buildWith(publicPost, {})).rejects.toThrow(/extra has no handler/);
    await expect(buildWith(publicPost, { extra: async () => ({}), stray: async () => ({}) })).rejects.toThrow(
      /Handlers for routes not in the table: stray/,
    );
    await expect(buildWith(publicPost, { extra: "not a function" })).rejects.toBeInstanceOf(RouteRegistrationError);
  });

  it("refuses extra routes that reuse a name of the table", async () => {
    const table = { health: publicPost } as const;
    await expect(
      buildApp(testConfig(), {
        logger: silentLogger,
        services,
        clock: fakeClock(),
        extraRoutes: { table, handlers: { health: async () => ({}) } },
      }),
    ).rejects.toThrow(/clash/);
  });

  it("types handlers from the contract", () => {
    const handlers: RouteHandlers<typeof testRoutes> = {
      ...testHandlers,
      // @ts-expect-error the response must match the contract's 200 schema
      testEcho: async (request) => ({ text: request.body.text.length }),
    };
    expect(Object.keys(handlers)).toHaveLength(4);
  });
});
