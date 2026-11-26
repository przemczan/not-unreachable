import type { getDashboardRoute } from "@not-unreachable/contracts";
import type { RouteHandlers } from "../../http/index.ts";
import type { DashboardService } from "./service.ts";

export type DashboardRoutes = {
  readonly getDashboard: typeof getDashboardRoute;
};

/** Admin only, as the route's contract says; the sessions guard enforces it before the handler runs. */
export function createDashboardHandlers(service: DashboardService): RouteHandlers<DashboardRoutes> {
  return {
    getDashboard: async () => service.read(),
  };
}
