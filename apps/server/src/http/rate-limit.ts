import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import { problemTypes } from "@not-unreachable/contracts";
import type { FastifyInstance } from "fastify";
import type { SettingsService } from "../modules/settings/index.ts";
import { isApiPath } from "./api-path.ts";
import { HttpProblem } from "./problems.ts";

const IPV6_GROUP_PREFIX = 64;

/** The bucket of an address: IPv4 as is, IPv4-mapped IPv6 as its IPv4, other IPv6 by its /64 (T11). */
export function rateLimitKey(ip: string): string {
  return normalizeIP(ip, IPV6_GROUP_PREFIX);
}

/**
 * The global API limit (T11), per client IP. It covers every `/api` request, unknown routes
 * included, and none of the static files or the SPA fallback, which cost little and that a page
 * load fetches many of. Max and window are read from the settings per request, so a change applies.
 */
export async function registerGlobalRateLimit(app: FastifyInstance, settings: SettingsService): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => rateLimitKey(request.ip),
    max: () => settings.get("globalRateLimit").max,
    timeWindow: () => settings.get("globalRateLimit").timeWindowSeconds * 1000,
    addHeadersOnExceeding: { "x-ratelimit-limit": false, "x-ratelimit-remaining": false, "x-ratelimit-reset": false },
    addHeaders: { "x-ratelimit-limit": false, "x-ratelimit-remaining": false, "x-ratelimit-reset": false, "retry-after": true },
    errorResponseBuilder: () => new HttpProblem(429, problemTypes.rateLimited),
  });
  const limit = app.rateLimit();
  app.addHook("onRequest", async function globalRateLimit(request, reply) {
    if (isApiPath(request.url)) await limit.call(this, request, reply);
  });
}
