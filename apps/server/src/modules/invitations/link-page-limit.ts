import {
  acceptInvitationRoute,
  getInvitationRoute,
  getRelinkRoute,
  problemTypes,
  startRelinkRoute,
  type RouteContract,
} from "@not-unreachable/contracts";
import type { FastifyInstance } from "fastify";
import { HttpProblem } from "../../http/index.ts";
import { rateLimitKey } from "../../http/rate-limit.ts";
import type { AuditService } from "../audit/index.ts";
import { MINUTE_MS, type Clock } from "../platform/index.ts";
import type { SettingsService } from "../settings/index.ts";

export const LINK_PAGE_LIMIT = "link-page-per-ip";

/** The public routes a link's token reaches, which someone guessing tokens would hammer (threat model, T11). */
export const linkPageRoutes: readonly RouteContract[] = [getInvitationRoute, acceptInvitationRoute, getRelinkRoute, startRelinkRoute];

/** How often the store drops addresses with no request in their window. */
const SWEEP_EVERY_MS = 5 * MINUTE_MS;

export interface LinkPageLimit {
  /** Counts a request; throws `429 rate-limited` with `Retry-After` past the limit. */
  beforeRequest(origin: { readonly ip: string; readonly userAgent: string | null }): void;
}

interface Entry {
  /** Times of the requests within the window, oldest first. */
  requests: number[];
  /** Until when this window's `rate-limit.triggered` is recorded already (once per key per window). */
  auditedUntil: number;
}

export interface LinkPageLimitDependencies {
  readonly settings: SettingsService;
  readonly audit: AuditService;
  readonly clock: Clock;
}

/**
 * The invitation and re-link pages' limit per IP (IPv6 by /64), kept in memory: the app is one
 * process. Max and window come from the `linkPageRateLimit` setting on every request.
 */
export function createLinkPageLimit({ settings, audit, clock }: LinkPageLimitDependencies): LinkPageLimit {
  const entries = new Map<string, Entry>();
  let lastSweep = clock.now().getTime();

  const sweep = (now: number, windowMs: number): void => {
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    for (const [key, entry] of entries) {
      if ((entry.requests.at(-1) ?? 0) <= now - windowMs && entry.auditedUntil <= now) entries.delete(key);
    }
  };

  return {
    beforeRequest({ ip, userAgent }) {
      const now = clock.now().getTime();
      const { max, timeWindowSeconds } = settings.get("linkPageRateLimit");
      const windowMs = timeWindowSeconds * 1000;
      sweep(now, windowMs);
      const key = rateLimitKey(ip);
      const entry = entries.get(key) ?? { requests: [], auditedUntil: 0 };
      entries.set(key, entry);
      entry.requests = entry.requests.filter((at) => at > now - windowMs);
      if (entry.requests.length < max) {
        entry.requests.push(now);
        return;
      }
      const retryAt = (entry.requests[entry.requests.length - max] ?? now) + windowMs;
      if (entry.auditedUntil <= now) {
        entry.auditedUntil = retryAt;
        audit.record({
          action: "rate-limit.triggered",
          actor: { kind: "anonymous" },
          outcome: "denied",
          origin: { ip, userAgent },
          details: { limit: LINK_PAGE_LIMIT, key },
        });
      }
      const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
      throw new HttpProblem(429, problemTypes.rateLimited, undefined, { "retry-after": String(seconds) });
    },
  };
}

/**
 * Applies the limit before anything else of the link routes runs, their validation included, so a
 * malformed request counts too. The routes are known by their contracts, the source of truth.
 */
export function registerLinkPageLimit(app: FastifyInstance, limit: LinkPageLimit): void {
  app.addHook("onRequest", async (request) => {
    const route = request.routeOptions.config.contract;
    if (route !== undefined && linkPageRoutes.includes(route)) limit.beforeRequest(request.requestContext);
  });
}
