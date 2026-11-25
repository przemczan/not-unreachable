import type { checkForUpdatesRoute, getUpdatesRoute, installUpdateRoute } from "@not-unreachable/contracts";
import { requireCaller, type RouteHandlers } from "../../http/index.ts";
import type { UpdatesService } from "./service.ts";

export type UpdatesRoutes = {
  readonly getUpdates: typeof getUpdatesRoute;
};

/** Registered apart from the table's other routes, and only while `UPDATE_CHECK` is on. */
export type CheckForUpdatesRoutes = {
  readonly checkForUpdates: typeof checkForUpdatesRoute;
};

/** Registered apart from the table's other routes, and only while `UPDATE_FROM_UI` is on. */
export type InstallUpdateRoutes = {
  readonly installUpdate: typeof installUpdateRoute;
};

export function createUpdatesHandlers(service: UpdatesService): RouteHandlers<UpdatesRoutes> {
  return {
    getUpdates: async () => service.overview(),
  };
}

export function createCheckForUpdatesHandlers(service: UpdatesService): RouteHandlers<CheckForUpdatesRoutes> {
  return {
    checkForUpdates: async () => service.checkNow(),
  };
}

export function createInstallUpdateHandlers(service: UpdatesService): RouteHandlers<InstallUpdateRoutes> {
  return {
    installUpdate: async (request, reply) => {
      const { version, reauthentication } = request.body;
      const requested = await service.install(requireCaller(request), version, reauthentication, request.requestContext);
      // The download and the helper go on after the answer; the overview tells how they end.
      return reply.code(202).send(requested);
    },
  };
}
