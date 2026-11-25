import {
  problemTypes,
  type addSsoProviderRoute,
  type changeSsoProviderRoute,
  type listLinkedSignInsRoute,
  type listSignInProvidersRoute,
  type listSsoProvidersRoute,
  type removeSsoProviderRoute,
  type ssoCallbackRoute,
  type startLinkRoute,
  type startSsoSignInRoute,
  type unlinkRoute,
} from "@not-unreachable/contracts";
import type { FastifyReply } from "fastify";
import { HttpProblem, requireCaller, type RouteHandlers } from "../../http/index.ts";
import { actorOf } from "../audit/index.ts";
import { SIGN_IN_PURPOSE, type SsoFlowsService, type StartedFlow } from "./flows.ts";
import { LINK_PURPOSE, type LinkedSignInsService } from "./linked-sign-ins.ts";
import type { SsoProvidersService } from "./providers.ts";

export type SsoRoutes = {
  readonly listSsoProviders: typeof listSsoProvidersRoute;
  readonly addSsoProvider: typeof addSsoProviderRoute;
  readonly changeSsoProvider: typeof changeSsoProviderRoute;
  readonly removeSsoProvider: typeof removeSsoProviderRoute;
  readonly listSignInProviders: typeof listSignInProvidersRoute;
  readonly startSsoSignIn: typeof startSsoSignInRoute;
  readonly ssoCallback: typeof ssoCallbackRoute;
  readonly listLinkedSignIns: typeof listLinkedSignInsRoute;
  readonly startLink: typeof startLinkRoute;
  readonly unlink: typeof unlinkRoute;
};

export interface SsoHandlersDependencies {
  readonly providers: SsoProvidersService;
  readonly flows: SsoFlowsService;
  readonly linkedSignIns: LinkedSignInsService;
}

/** Sends the browser on to the provider: the flow's cookie, and the URL for the SPA to go to. */
function redirectTo(reply: FastifyReply, started: StartedFlow | undefined): { url: string } {
  // The sign-in page lists only enabled providers anyway, so a 404 tells nobody anything new.
  if (started === undefined) throw new HttpProblem(404, problemTypes.notFound);
  reply.header("set-cookie", started.cookie);
  return { url: started.url };
}

export function createSsoHandlers({ providers, flows, linkedSignIns }: SsoHandlersDependencies): RouteHandlers<SsoRoutes> {
  return {
    listSsoProviders: async () => ({ providers: providers.list(), publicOrigin: providers.publicOrigin }),

    addSsoProvider: async (request, reply) => {
      const caller = requireCaller(request);
      const provider = await providers.add(request.body, { actor: actorOf(caller), origin: request.requestContext });
      return reply.code(201).send(provider);
    },

    changeSsoProvider: async (request) => {
      const caller = requireCaller(request);
      return providers.change(request.params.id, request.body, { actor: actorOf(caller), origin: request.requestContext });
    },

    removeSsoProvider: async (request, reply) => {
      const caller = requireCaller(request);
      providers.remove(request.params.id, { actor: actorOf(caller), origin: request.requestContext });
      return reply.code(204).send();
    },

    listSignInProviders: async () => ({ providers: providers.listForSignIn() }),

    startSsoSignIn: async (request, reply) =>
      redirectTo(reply, await flows.start(request.params.id, SIGN_IN_PURPOSE, {}, request.requestContext)),

    ssoCallback: async (request, reply) => {
      const answer = await flows.callback(request.params.id, request.query, request.headers.cookie, request.requestContext);
      return reply
        .code(303)
        .header("location", answer.location)
        .header("set-cookie", [...answer.cookies])
        .send();
    },

    listLinkedSignIns: async (request) => {
      const caller = requireCaller(request);
      return { linkedSignIns: linkedSignIns.list({ id: caller.accountId, role: caller.role }) };
    },

    startLink: async (request, reply) => {
      const caller = requireCaller(request);
      const context = { accountId: caller.accountId, sessionId: caller.sessionId };
      return redirectTo(reply, await flows.start(request.body.providerId, LINK_PURPOSE, context, request.requestContext));
    },

    unlink: async (request, reply) => {
      const caller = requireCaller(request);
      const unlinked = linkedSignIns.unlink({ id: caller.accountId, role: caller.role }, request.params.id, {
        actor: actorOf(caller),
        origin: request.requestContext,
      });
      if (unlinked === "not-found") throw new HttpProblem(404, problemTypes.notFound);
      if (unlinked === "last-sign-in-method") {
        throw new HttpProblem(409, problemTypes.lastSignInMethod, "Link another sign-in before you remove this one.");
      }
      return reply.code(204).send();
    },
  };
}
