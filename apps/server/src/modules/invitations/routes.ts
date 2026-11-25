import type {
  acceptInvitationRoute,
  changeUserRoute,
  createInvitationRoute,
  createRelinkLinkRoute,
  getInvitationLinkRoute,
  getInvitationRoute,
  getRelinkRoute,
  getUserRoute,
  listInvitationsRoute,
  listUsersRoute,
  removeUserLinkedSignInRoute,
  removeUserRoute,
  resendInvitationRoute,
  revokeInvitationRoute,
  setDefaultQuotaRoute,
  startRelinkRoute,
} from "@not-unreachable/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireCaller, type RouteHandlers } from "../../http/index.ts";
import { actorOf } from "../audit/index.ts";
import type { StartedFlow } from "../sso/index.ts";
import type { LinkPagesService } from "./accept.ts";
import type { AdminContext } from "./links.ts";
import type { InvitationsService } from "./service.ts";
import type { UsersService } from "./users.ts";

export type InvitationsRoutes = {
  readonly listInvitations: typeof listInvitationsRoute;
  readonly createInvitation: typeof createInvitationRoute;
  readonly getInvitationLink: typeof getInvitationLinkRoute;
  readonly resendInvitation: typeof resendInvitationRoute;
  readonly revokeInvitation: typeof revokeInvitationRoute;
  readonly getInvitation: typeof getInvitationRoute;
  readonly acceptInvitation: typeof acceptInvitationRoute;
  readonly getRelink: typeof getRelinkRoute;
  readonly startRelink: typeof startRelinkRoute;
  readonly listUsers: typeof listUsersRoute;
  readonly getUser: typeof getUserRoute;
  readonly changeUser: typeof changeUserRoute;
  readonly removeUser: typeof removeUserRoute;
  readonly removeUserLinkedSignIn: typeof removeUserLinkedSignInRoute;
  readonly createRelinkLink: typeof createRelinkLinkRoute;
  readonly setDefaultQuota: typeof setDefaultQuotaRoute;
};

export interface InvitationsHandlersDependencies {
  readonly invitations: InvitationsService;
  readonly linkPages: LinkPagesService;
  readonly users: UsersService;
}

const adminContext = (request: FastifyRequest): AdminContext => ({
  actor: actorOf(requireCaller(request)),
  origin: request.requestContext,
});

/** Sends the browser on to the provider: the flow's cookie, and the URL for the SPA to go to. */
function redirectTo(reply: FastifyReply, started: StartedFlow): { url: string } {
  reply.header("set-cookie", started.cookie);
  return { url: started.url };
}

export function createInvitationsHandlers({
  invitations,
  linkPages,
  users,
}: InvitationsHandlersDependencies): RouteHandlers<InvitationsRoutes> {
  return {
    listInvitations: async () => invitations.list(),

    createInvitation: async (request, reply) => reply.code(201).send(await invitations.create(request.body, adminContext(request))),

    getInvitationLink: async (request) => invitations.linkOf(request.params.id),

    resendInvitation: async (request) => invitations.resend(request.params.id, adminContext(request)),

    revokeInvitation: async (request, reply) => {
      invitations.revoke(request.params.id, adminContext(request));
      return reply.code(204).send();
    },

    getInvitation: async (request) => linkPages.invitationOffer(request.params.token),

    acceptInvitation: async (request, reply) =>
      redirectTo(reply, await linkPages.startAccept(request.params.token, request.body, request.requestContext)),

    getRelink: async (request) => linkPages.relinkOffer(request.params.token),

    startRelink: async (request, reply) =>
      redirectTo(reply, await linkPages.startRelink(request.params.token, request.body.providerId, request.requestContext)),

    listUsers: async () => users.list(),

    getUser: async (request) => users.get(request.params.id),

    changeUser: async (request) => users.change(request.params.id, request.body, adminContext(request)),

    removeUser: async (request, reply) => {
      await users.remove(request.params.id, request.body.homeFolder, adminContext(request));
      return reply.code(204).send();
    },

    removeUserLinkedSignIn: async (request, reply) => {
      users.unlink(request.params.id, request.params.link, adminContext(request));
      return reply.code(204).send();
    },

    createRelinkLink: async (request, reply) =>
      reply.code(201).send(await users.createRelinkLink(request.params.id, adminContext(request))),

    setDefaultQuota: async (request) => users.setDefaultQuota(request.body.defaultQuotaBytes, adminContext(request)),
  };
}
