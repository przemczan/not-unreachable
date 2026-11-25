import { problemTypes, usernameSchema } from "@not-unreachable/contracts";
import { HttpProblem } from "../../http/index.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import type { InvitationsRepository } from "./repository.ts";

export type UsernameRefusal = "username-taken" | "username-reserved";

export interface Usernames {
  /** Why a new account can't take the username; undefined when it can. */
  refusalFor(username: string): Promise<UsernameRefusal | undefined>;
  /** A free, valid username from an email's local part, or null. */
  suggestFrom(email: string | null): Promise<string | null>;
}

export interface UsernamesDependencies {
  readonly accounts: Pick<AccountsService, "isUsernameTaken">;
  readonly resources: Pick<ResourcesService, "homeExists" | "forgetHome">;
  readonly repository: InvitationsRepository;
}

export function usernameProblem(refusal: UsernameRefusal): HttpProblem {
  return refusal === "username-taken"
    ? new HttpProblem(409, problemTypes.usernameTaken, "Choose another username.")
    : new HttpProblem(409, problemTypes.usernameReserved, "A removed user's files are kept under this name. Choose another username.");
}

/**
 * Which usernames a new account may take: not an account's, and not a removed user's whose home
 * was kept, so a new user never inherits someone else's files. A reservation ends once its folder
 * is gone from disk; this is the only place that drops one.
 */
export function createUsernames({ accounts, resources, repository }: UsernamesDependencies): Usernames {
  const refusalFor = async (username: string): Promise<UsernameRefusal | undefined> => {
    if (accounts.isUsernameTaken(username)) return "username-taken";
    if (repository.findReservation(username) === undefined) return undefined;
    if (await resources.homeExists(username)) return "username-reserved";
    repository.dropReservation(username);
    resources.forgetHome(username);
    return undefined;
  };

  return {
    refusalFor,

    async suggestFrom(email) {
      if (email === null) return null;
      const candidate = (email.split("@")[0] ?? "").toLowerCase().replaceAll(/[^a-z0-9._-]/g, "");
      if (!usernameSchema.safeParse(candidate).success) return null;
      return (await refusalFor(candidate)) === undefined ? candidate : null;
    },
  };
}
