import { publicShareLinkRoutes, type RouteContract } from "@not-unreachable/contracts";
import type { FastifyInstance } from "fastify";
import type { PasswordHasher } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import { DAY_MS, decodeAsciiEscapes, type Clock, type Db, type JobScheduler, type Secrets } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import type { SettingsService } from "../settings/index.ts";
import { createDownloadSlots, createShareTokenLimit, createWrongPasswordCounter, type ShareTokenLimit } from "./limits.ts";
import { createPublicShareLinks, type PublicShareLinks } from "./public.ts";
import { createShareLinksRepository } from "./repository.ts";
import { createShareLinksService, type ShareLinksService } from "./service.ts";

export { createShareLinksHandlers, type ShareLinksRoutes } from "./routes.ts";
export { shareLinks, shareLinkUnlocks, type ShareLinkRow, type ShareLinkUnlockRow } from "./schema.ts";
export { tokenAad, type ShareLinksService } from "./service.ts";
export type { PublicShareLinks } from "./public.ts";
export type { ShareTokenLimit } from "./limits.ts";

export const SHARE_LINK_UNLOCKS_PURGE_JOB = "share-link-unlocks-purge";

/** The share page and the public share API are never indexed (threat model, T8). */
export const SHARE_ROBOTS_TAG = "noindex, nofollow";

export interface ShareLinksDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly resources: Pick<ResourcesService, "rootFor" | "get">;
  /** The accounts module's hasher, whose limiter holds for the whole process. */
  readonly hasher: PasswordHasher;
  readonly secrets: Secrets | undefined;
  readonly publicOrigin: string;
  readonly settings: SettingsService;
}

export interface ShareLinksModule {
  readonly shareLinks: ShareLinksService;
  readonly publicShareLinks: PublicShareLinks;
  readonly shareTokenLimit: ShareTokenLimit;
}

export function createShareLinksModule({
  db,
  clock,
  audit,
  resources,
  hasher,
  secrets,
  publicOrigin,
  settings,
}: ShareLinksDependencies): ShareLinksModule {
  const repository = createShareLinksRepository(db);
  const shareTokenLimit = createShareTokenLimit({ settings, audit, clock });
  return {
    shareLinks: createShareLinksService({ repository, resources, hasher, audit, clock, secrets, publicOrigin }),
    publicShareLinks: createPublicShareLinks({
      repository,
      resources,
      hasher,
      audit,
      clock,
      tokenLimit: shareTokenLimit,
      wrongPasswords: createWrongPasswordCounter({ settings, clock }),
      downloads: createDownloadSlots(settings),
    }),
    shareTokenLimit,
  };
}

const sharePagePattern = /^\/s(\/|$)/;

/**
 * Before anything else of the public share routes runs: `X-Robots-Tag` on them and on the `/s/`
 * page, and the 429 for an IP blocked after too many invalid tokens. Routes are known by their contracts.
 */
export function registerShareLinkHooks(app: FastifyInstance, limit: ShareTokenLimit): void {
  const shareRoutes: readonly RouteContract[] = publicShareLinkRoutes;
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.config.contract;
    const isShareRoute = route !== undefined && shareRoutes.includes(route);
    if (isShareRoute || sharePagePattern.test(decodeAsciiEscapes(request.url))) reply.header("x-robots-tag", SHARE_ROBOTS_TAG);
    if (isShareRoute) limit.assertAllowed(request.requestContext);
  });
}

/** The daily purge of expired unlocks. */
export function scheduleShareLinkUnlocksPurge(jobs: JobScheduler, shareLinks: Pick<ShareLinksService, "purgeExpiredUnlocks">): void {
  jobs.register({
    name: SHARE_LINK_UNLOCKS_PURGE_JOB,
    intervalMs: DAY_MS,
    run: async () => {
      shareLinks.purgeExpiredUnlocks();
    },
  });
}
