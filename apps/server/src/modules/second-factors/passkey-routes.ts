import {
  problemTypes,
  type addPasskeyRoute,
  type listPasskeysRoute,
  type removePasskeyRoute,
  type renamePasskeyRoute,
  type startPasskeyRegistrationRoute,
} from "@not-unreachable/contracts";
import { HttpProblem, requireCaller, type RouteHandlers } from "../../http/index.ts";
import type { AccountRecord, AccountsService } from "../accounts/index.ts";
import { actorOf } from "../audit/index.ts";
import type { PasskeysService } from "./passkeys.ts";

/** Settings → Two-step sign-in → Passkeys, for the admin. */
export type PasskeysRoutes = {
  readonly listPasskeys: typeof listPasskeysRoute;
  readonly startPasskeyRegistration: typeof startPasskeyRegistrationRoute;
  readonly addPasskey: typeof addPasskeyRoute;
  readonly renamePasskey: typeof renamePasskeyRoute;
  readonly removePasskey: typeof removePasskeyRoute;
};

export function createPasskeysHandlers(
  passkeys: PasskeysService,
  accounts: Pick<AccountsService, "findById">,
): RouteHandlers<PasskeysRoutes> {
  const accountOf = (accountId: string): AccountRecord => {
    const account = accounts.findById(accountId);
    if (account === undefined) throw new HttpProblem(401, problemTypes.signInRequired);
    return account;
  };

  return {
    listPasskeys: async (request) => ({ passkeys: passkeys.list(requireCaller(request).accountId) }),

    startPasskeyRegistration: async (request) => {
      const caller = requireCaller(request);
      return passkeys.registrationOptions(accountOf(caller.accountId), caller.sessionId);
    },

    addPasskey: async (request) => {
      const caller = requireCaller(request);
      const added = await passkeys.register(accountOf(caller.accountId), request.body, caller.sessionId, {
        actor: actorOf(caller),
        origin: request.requestContext,
      });
      if (added === undefined) {
        throw new HttpProblem(422, problemTypes.secondFactorFailed, "The passkey could not be added. Try again.");
      }
      return added;
    },

    renamePasskey: async (request) => {
      const renamed = passkeys.rename(requireCaller(request).accountId, request.params.id, request.body.name);
      if (renamed === undefined) throw new HttpProblem(404, problemTypes.notFound);
      return renamed;
    },

    removePasskey: async (request, reply) => {
      const caller = requireCaller(request);
      const removed = passkeys.remove(caller.accountId, request.params.id, { actor: actorOf(caller), origin: request.requestContext });
      if (removed === "not-found") throw new HttpProblem(404, problemTypes.notFound);
      if (removed === "last-factor") {
        throw new HttpProblem(409, problemTypes.lastSecondFactor, "Add another second factor before you remove this one.");
      }
      return reply.code(204).send();
    },
  };
}
