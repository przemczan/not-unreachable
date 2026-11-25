import type { Routes } from "@not-unreachable/contracts";
import type { RouteHandlers } from "../../http/index.ts";

/** `GET /api/v1/health`: the process is up and serving. */
export const healthHandlers: Pick<RouteHandlers<Routes>, "health"> = {
  health: async () => ({ status: "ok" }),
};
