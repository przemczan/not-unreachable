import { problemTypes } from "@not-unreachable/contracts";
import type { FastifyInstance } from "fastify";
import { isApiPath } from "./api-path.ts";
import { problem, sendProblem } from "./problems.ts";
import { sendSpaIndex } from "./static-web.ts";

/** A missing hashed asset is a stale build, not a client route: answering it with HTML would only hide that. */
function isAssetPath(url: string): boolean {
  return url.startsWith("/assets/");
}

/**
 * Unknown `/api` paths, unknown non-GET requests and missing assets get a 404 problem. With the
 * SPA served, any other GET or HEAD gets `index.html`, for the client router.
 */
export function registerNotFound(app: FastifyInstance, options: { readonly spa: boolean }): void {
  app.setNotFoundHandler(async (request, reply) => {
    const readOnly = request.method === "GET" || request.method === "HEAD";
    if (options.spa && readOnly && !isApiPath(request.url) && !isAssetPath(request.url)) return sendSpaIndex(reply);
    return sendProblem(reply, problem(404, problemTypes.notFound));
  });
}
