import type { getSecuritySettingsRoute, updateSecuritySettingsRoute } from "@not-unreachable/contracts";
import { requireCaller, type RouteHandlers } from "../../http/index.ts";
import type { SecuritySettingsService } from "./service.ts";

export type SecuritySettingsRoutes = {
  readonly getSecuritySettings: typeof getSecuritySettingsRoute;
  readonly updateSecuritySettings: typeof updateSecuritySettingsRoute;
};

export function createSecuritySettingsHandlers(service: SecuritySettingsService): RouteHandlers<SecuritySettingsRoutes> {
  return {
    getSecuritySettings: async () => service.read(),
    updateSecuritySettings: async (request) => {
      const caller = requireCaller(request);
      return service.update(
        request.body,
        { kind: "account", accountId: caller.accountId, username: caller.username },
        request.requestContext,
      );
    },
  };
}
