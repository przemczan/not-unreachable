import type {
  changeShareLinkRoute,
  createShareLinkRoute,
  downloadShareLinkContentRoute,
  getPublicShareLinkRoute,
  getShareLinkRoute,
  listShareLinkEntriesRoute,
  listSharedWithMeRoute,
  listShareLinksRoute,
  revokeShareLinkRoute,
  unlockShareLinkRoute,
} from "@not-unreachable/contracts";
import type { FastifyRequest } from "fastify";
import { requireCaller, type RouteHandlers } from "../../http/index.ts";
import { actorOf } from "../audit/index.ts";
import { mappedFileRefusals as mapped, sendContained, type DownloadStart } from "../files/index.ts";
import type { PublicShareLinks, ShareRequest } from "./public.ts";
import { nameOf, type AdminContext, type ShareLinksService } from "./service.ts";

export type ShareLinksRoutes = {
  readonly createShareLink: typeof createShareLinkRoute;
  readonly listShareLinks: typeof listShareLinksRoute;
  readonly getShareLink: typeof getShareLinkRoute;
  readonly changeShareLink: typeof changeShareLinkRoute;
  readonly revokeShareLink: typeof revokeShareLinkRoute;
  readonly listSharedWithMe: typeof listSharedWithMeRoute;
  readonly getPublicShareLink: typeof getPublicShareLinkRoute;
  readonly unlockShareLink: typeof unlockShareLinkRoute;
  readonly listShareLinkEntries: typeof listShareLinkEntriesRoute;
  readonly downloadShareLinkContent: typeof downloadShareLinkContentRoute;
};

const adminContext = (request: FastifyRequest): AdminContext => ({
  actor: actorOf(requireCaller(request)),
  origin: request.requestContext,
});

const shareRequest = (request: FastifyRequest): ShareRequest => ({
  origin: request.requestContext,
  cookieHeader: request.headers.cookie,
  caller: request.requestContext.caller,
});

/** The download-count rule (T8): a whole file, or a range from its first byte; never a HEAD, which sends no body. */
function counts(request: FastifyRequest, start: DownloadStart): boolean {
  return request.method === "GET" && start.start === 0;
}

export function createShareLinksHandlers(service: ShareLinksService, publicLinks: PublicShareLinks): RouteHandlers<ShareLinksRoutes> {
  return {
    createShareLink: async (request, reply) =>
      reply.code(201).send(await mapped(() => service.create(request.body, adminContext(request)))),

    listShareLinks: async (request) => service.list(request.query),

    getShareLink: async (request) => service.get(request.params.id),

    changeShareLink: async (request) => service.change(request.params.id, request.body, adminContext(request)),

    revokeShareLink: async (request) => service.revoke(request.params.id, adminContext(request)),

    listSharedWithMe: async (request) => service.listSharedWith(requireCaller(request).accountId, request.query),

    getPublicShareLink: async (request) => publicLinks.describe(request.params.token, shareRequest(request)),

    unlockShareLink: async (request, reply) => {
      const cookie = await publicLinks.unlock(request.params.token, request.body.password, shareRequest(request));
      return reply.header("set-cookie", cookie).code(204).send();
    },

    listShareLinkEntries: async (request) => mapped(() => publicLinks.entries(request.params.token, request.query, shareRequest(request))),

    downloadShareLinkContent: async (request, reply) => {
      const call = shareRequest(request);
      const shared = await mapped(() => publicLinks.file(request.params.token, request.query.path, call));
      const release = publicLinks.startDownload(shared, call);
      reply.raw.once("close", release);
      reply.raw.once("finish", release);
      try {
        // Counted as the download starts: the reply sendContained answers settles only once the body is sent.
        return await mapped(() =>
          sendContained(request, reply, shared.file, shared.path === "" ? nameOf(shared.link) : undefined, (start) => {
            if (counts(request, start)) publicLinks.countDownload(shared, call);
          }),
        );
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
