import type { FastifyInstance } from "fastify";
import { isApiPath } from "./api-path.ts";

/** `Cache-Control: no-store` on every `/api` response, errors and 404s included (T13). Set first, so every later path keeps it. */
export function registerApiNoStore(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isApiPath(request.url)) reply.header("cache-control", "no-store");
  });
}
