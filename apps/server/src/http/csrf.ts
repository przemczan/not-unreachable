import { problemTypes } from "@not-unreachable/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../modules/platform/index.ts";
import { HttpProblem } from "./problems.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const REQUEST_MARKER_HEADER = "x-nu-request";

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function hasBody(request: FastifyRequest): boolean {
  const length = single(request.headers["content-length"]);
  return request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase();
}

/** JSON, or the raw media type the route's contract takes instead (tus chunks). */
function isAcceptedBody(request: FastifyRequest): boolean {
  const mediaType = mediaTypeOf(single(request.headers["content-type"]));
  if (mediaType === "application/json") return true;
  const rawBody = request.routeOptions.config.contract?.rawBody;
  return rawBody !== undefined && mediaType === rawBody.mediaType;
}

/**
 * CSRF checks (threat model, T3) for every method but GET, HEAD and OPTIONS: the origin must be
 * ours, the request must carry `X-NU-Request: 1`, and a body must be JSON, or the raw media type its
 * route's contract names. CORS headers are never sent.
 */
export function registerCsrfChecks(app: FastifyInstance, config: Pick<Config, "publicOrigin">): void {
  app.addHook("onRequest", async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = single(request.headers.origin);
    const fetchSite = single(request.headers["sec-fetch-site"]);
    const sameOrigin = origin === undefined ? fetchSite === "same-origin" : origin === config.publicOrigin;
    if (!sameOrigin) throw new HttpProblem(403, problemTypes.csrfRejected, "The request did not come from this site.");
    if (single(request.headers[REQUEST_MARKER_HEADER]) !== "1") {
      throw new HttpProblem(403, problemTypes.csrfRejected, "The request lacks the X-NU-Request header.");
    }
    if (hasBody(request) && !isAcceptedBody(request)) {
      throw new HttpProblem(415, problemTypes.unsupportedMediaType, "Request bodies must be application/json.");
    }
  });
}
