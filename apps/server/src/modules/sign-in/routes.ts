import {
  problemTypes,
  type changePasswordRoute,
  type confirmSessionRoute,
  type getSessionRoute,
  type passkeySignInRoute,
  type Session,
  type SessionState,
  type signInRoute,
  type signOutRoute,
  type startPasskeyConfirmationRoute,
  type startPasskeySignInRoute,
} from "@not-unreachable/contracts";
import { HttpProblem, RECENT_SIGN_IN_MS, requireCaller, type Caller, type RouteHandlers } from "../../http/index.ts";
import { toAccount, type AccountRecord, type AccountsService } from "../accounts/index.ts";
import { newToken, type Clock } from "../platform/index.ts";
import { clearedSessionCookie, sessionCookie } from "../sessions/index.ts";
import type { SignInService } from "./service.ts";
import { clearedWebAuthnCookie, readWebAuthnToken, webAuthnCookie } from "./webauthn-cookie.ts";

export type SignInRoutes = {
  readonly signIn: typeof signInRoute;
  readonly signOut: typeof signOutRoute;
  readonly getSession: typeof getSessionRoute;
  readonly confirmSession: typeof confirmSessionRoute;
  readonly changePassword: typeof changePasswordRoute;
  readonly startPasskeySignIn: typeof startPasskeySignInRoute;
  readonly passkeySignIn: typeof passkeySignInRoute;
  readonly startPasskeyConfirmation: typeof startPasskeyConfirmationRoute;
};

export function sessionView(account: AccountRecord, state: SessionState, recentSignInAt: Date | null): Session {
  return {
    account: toAccount(account),
    state,
    recentSignInUntil: recentSignInAt === null ? null : new Date(recentSignInAt.getTime() + RECENT_SIGN_IN_MS).toISOString(),
  };
}

export function createSignInHandlers(signIn: SignInService, accounts: AccountsService, clock: Clock): RouteHandlers<SignInRoutes> {
  const accountOf = (caller: Caller): AccountRecord => {
    const account = accounts.findById(caller.accountId);
    if (account === undefined) throw new HttpProblem(401, problemTypes.signInRequired);
    return account;
  };

  return {
    signIn: async (request, reply) => {
      const { session, token } = await signIn.signIn(request.body, request.requestContext, request.requestContext.caller);
      reply.header("set-cookie", sessionCookie(token));
      return sessionView(session.account, session.state, session.recentSignInAt === null ? null : new Date(session.recentSignInAt));
    },

    startPasskeySignIn: async (request, reply) => {
      const browserToken = newToken();
      reply.header("set-cookie", webAuthnCookie(browserToken));
      return signIn.passkeySignInOptions(browserToken);
    },

    passkeySignIn: async (request, reply) => {
      // Cleared first, so it goes out with a failure too: a challenge is used once.
      reply.header("set-cookie", clearedWebAuthnCookie());
      const { session, token } = await signIn.passkeySignIn(
        readWebAuthnToken(request.headers.cookie),
        request.body.response,
        request.requestContext,
        request.requestContext.caller,
      );
      // Fastify appends each `set-cookie`, so this goes out beside the cleared one above.
      reply.header("set-cookie", sessionCookie(token));
      return sessionView(session.account, session.state, session.recentSignInAt === null ? null : new Date(session.recentSignInAt));
    },

    startPasskeyConfirmation: async (request) => signIn.passkeyConfirmationOptions(requireCaller(request)),

    signOut: async (request, reply) => {
      signIn.signOut(requireCaller(request), request.requestContext);
      return reply.header("set-cookie", clearedSessionCookie()).code(204).send();
    },

    getSession: async (request) => {
      const caller = requireCaller(request);
      return sessionView(accountOf(caller), caller.state, caller.recentSignInAt);
    },

    confirmSession: async (request, reply) => {
      const caller = requireCaller(request);
      const token = await signIn.confirm(caller, request.body, request.requestContext);
      reply.header("set-cookie", sessionCookie(token));
      return sessionView(accountOf(caller), caller.state, clock.now());
    },

    changePassword: async (request, reply) => {
      const caller = requireCaller(request);
      const { currentPassword, newPassword } = request.body;
      const token = await signIn.changePassword(caller, currentPassword, newPassword, request.requestContext);
      return reply.header("set-cookie", sessionCookie(token)).code(204).send();
    },
  };
}
