import {
  problemTypes,
  type addTotpRoute,
  type confirmTotpRoute,
  type getSecondFactorsRoute,
  type regenerateRecoveryCodesRoute,
  type removeTotpRoute,
} from "@not-unreachable/contracts";
import { HttpProblem, requireCaller, type RouteHandlers } from "../../http/index.ts";
import type { AccountRecord, AccountsService } from "../accounts/index.ts";
import { actorOf } from "../audit/index.ts";
import type { SecondFactorsService } from "./service.ts";

/** Settings → Two-step sign-in, for the admin. */
export type SecondFactorsRoutes = {
  readonly getSecondFactors: typeof getSecondFactorsRoute;
  readonly addTotp: typeof addTotpRoute;
  readonly confirmTotp: typeof confirmTotpRoute;
  readonly removeTotp: typeof removeTotpRoute;
  readonly regenerateRecoveryCodes: typeof regenerateRecoveryCodesRoute;
};

export function createSecondFactorsHandlers(
  secondFactors: SecondFactorsService,
  accounts: Pick<AccountsService, "findById">,
): RouteHandlers<SecondFactorsRoutes> {
  const accountOf = (accountId: string): AccountRecord => {
    const account = accounts.findById(accountId);
    if (account === undefined) throw new HttpProblem(401, problemTypes.signInRequired);
    return account;
  };

  return {
    getSecondFactors: async (request) => {
      const { accountId } = requireCaller(request);
      return { factors: secondFactors.listFactors(accountId), recoveryCodes: secondFactors.recoveryCodeStatus(accountId) };
    },

    addTotp: async (request) => {
      const caller = requireCaller(request);
      return secondFactors.startTotpEnrolment(accountOf(caller.accountId), caller.sessionId);
    },

    confirmTotp: async (request) => {
      const caller = requireCaller(request);
      const confirmed = await secondFactors.confirmTotpEnrolment(
        accountOf(caller.accountId),
        request.params.id,
        request.body.code,
        caller.sessionId,
        { actor: actorOf(caller), origin: request.requestContext },
      );
      if (confirmed === undefined)
        throw new HttpProblem(422, problemTypes.secondFactorFailed, "The code is not right, or the setup expired.");
      return confirmed.factor;
    },

    removeTotp: async (request, reply) => {
      const caller = requireCaller(request);
      const removed = secondFactors.removeTotp(caller.accountId, request.params.id, {
        actor: actorOf(caller),
        origin: request.requestContext,
      });
      if (removed === "not-found") throw new HttpProblem(404, problemTypes.notFound);
      if (removed === "last-factor") {
        throw new HttpProblem(409, problemTypes.lastSecondFactor, "Add another second factor before you remove this one.");
      }
      return reply.code(204).send();
    },

    regenerateRecoveryCodes: async (request) => {
      const caller = requireCaller(request);
      return {
        recoveryCodes: await secondFactors.regenerateRecoveryCodes(caller.accountId, {
          actor: actorOf(caller),
          origin: request.requestContext,
        }),
      };
    },
  };
}
