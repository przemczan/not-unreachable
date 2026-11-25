import {
  problemTypes,
  type getProfileRoute,
  type setupRoute,
  type setupStatusRoute,
  type updateProfileRoute,
} from "@not-unreachable/contracts";
import { hasRecentSignIn, HttpProblem, requireCaller, type RouteHandlers } from "../../http/index.ts";
import type { Clock } from "../platform/index.ts";
import { toAccount, type AccountsService } from "./service.ts";
import type { SetupService } from "./setup.ts";

export type AccountsRoutes = {
  readonly setupStatus: typeof setupStatusRoute;
  readonly setup: typeof setupRoute;
  readonly getProfile: typeof getProfileRoute;
  readonly updateProfile: typeof updateProfileRoute;
};

export function createAccountsHandlers(accounts: AccountsService, setup: SetupService, clock: Clock): RouteHandlers<AccountsRoutes> {
  const profileOf = (accountId: string) => {
    const account = accounts.findById(accountId);
    if (account === undefined) throw new HttpProblem(404, problemTypes.notFound);
    return toAccount(account);
  };

  return {
    setupStatus: async () => setup.status(),
    setup: async (request) => setup.complete(request.body, request.requestContext),
    getProfile: async (request) => profileOf(requireCaller(request).accountId),
    updateProfile: async (request) => {
      const caller = requireCaller(request);
      const updated = accounts.updateProfile(caller.accountId, request.body, {
        actor: { kind: "account", accountId: caller.accountId, username: caller.username },
        origin: request.requestContext,
        recentSignIn: hasRecentSignIn(caller, clock),
      });
      return toAccount(updated);
    },
  };
}
