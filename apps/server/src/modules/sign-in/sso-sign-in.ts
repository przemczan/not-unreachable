import { SSO_SIGN_IN_COMPLETE_PATH, SSO_SIGN_IN_FAILED_PATH } from "@not-unreachable/contracts";
import type { AccountsService } from "../accounts/index.ts";
import { actorOf, type AuditService } from "../audit/index.ts";
import { sessionCookie, type SessionsService } from "../sessions/index.ts";
import {
  SIGN_IN_PURPOSE,
  type LinkedSignInsService,
  type SsoFailureReason,
  type SsoOrigin,
  type SsoPurpose,
  type SsoRedirect,
} from "../sso/index.ts";

export interface SsoSignInDependencies {
  readonly accounts: Pick<AccountsService, "findById">;
  readonly sessions: SessionsService;
  readonly linkedSignIns: LinkedSignInsService;
  readonly audit: AuditService;
}

/**
 * Signing in through an SSO provider (threat model, T9): only an identity linked by (issuer,
 * subject) signs in, never one matched by email, and there is no sign-up. Every refusal lands on the
 * same page with the same answer; only `sign-in.failed` records why. A user's session is active at
 * once (their provider's MFA stands in for a second factor); the admin's always waits for its second
 * step (T10), which records `sign-in.succeeded`.
 */
export function createSsoSignInPurpose({ accounts, sessions, linkedSignIns, audit }: SsoSignInDependencies): SsoPurpose {
  const refuse = (reason: SsoFailureReason, providerId: string | null, accountId: string | null, origin: SsoOrigin): SsoRedirect => {
    audit.record({
      action: "sign-in.failed",
      actor: { kind: "anonymous" },
      outcome: "failed",
      ...(accountId === null ? {} : { target: { kind: "account", id: accountId } }),
      origin,
      details: { method: "sso", providerId, reason },
    });
    return { location: SSO_SIGN_IN_FAILED_PATH };
  };

  return {
    purpose: SIGN_IN_PURPOSE,

    complete(identity, flow, origin) {
      const providerId = flow.provider.id;
      const link = linkedSignIns.findByIdentity(identity.issuer, identity.subject);
      if (link?.providerId !== providerId) return refuse("unknown-identity", providerId, null, origin);
      if (!flow.provider.enabled) return refuse("disabled-provider", providerId, link.accountId, origin);
      const account = accounts.findById(link.accountId);
      if (account?.status !== "active") return refuse("disabled", providerId, link.accountId, origin);

      linkedSignIns.touch(link.id);
      const admin = account.role === "admin";
      const { token } = sessions.start({
        account,
        state: admin ? "pendingSecondFactor" : "active",
        recentSignIn: !admin,
        method: "sso",
        origin,
      });
      if (!admin) {
        audit.record({
          action: "sign-in.succeeded",
          actor: actorOf({ accountId: account.id, username: account.username }),
          outcome: "succeeded",
          target: { kind: "account", id: account.id },
          origin,
          details: { method: "sso", secondFactor: null },
        });
      }
      return { location: SSO_SIGN_IN_COMPLETE_PATH, cookies: [sessionCookie(token)] };
    },

    failed: (failure, _flow, origin) => refuse(failure.reason, failure.providerId, null, origin),
  };
}
