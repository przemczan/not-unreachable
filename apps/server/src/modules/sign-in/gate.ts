import type { HttpProblem } from "../../http/index.ts";
import type { AccountRecord } from "../accounts/index.ts";

/** What a password proof is for: signing in, renewing a recent sign-in, or changing the password. */
export type PasswordProofKind = "sign-in" | "confirm" | "password-change";

/** What the per-IP limits count: every password proof, the start and callback of an SSO flow, and a passwordless passkey sign-in. */
export type AttemptKind = PasswordProofKind | "sso" | "passkey";

export interface SignInAttempt {
  readonly kind: PasswordProofKind;
  /** The client's address (`request.ip`); grouping IPv6 by /64 is the gate's business. */
  readonly ip: string;
  /** The client's `User-Agent`, for the audit events the gate records. */
  readonly userAgent: string | null;
  /** The username or email as given; the caller's username when signed in. */
  readonly identifier: string;
  /** The account the identifier names; undefined when none does. */
  readonly account: AccountRecord | undefined;
}

/** A gate's refusal: the reason `sign-in.failed` records, and the answer the caller gets. */
export interface SignInRefusal {
  readonly reason: "delayed" | "locked";
  readonly problem: HttpProblem;
}

/**
 * Where the sign-in limits of threat model T11 plug into every password proof. The flow calls,
 * in order: `beforeAttempt` (before the account is looked up), `beforePasswordCheck` (before
 * argon2 runs), then `recordFailure` or `recordSuccess`.
 */
export interface SignInGate {
  /** Per-IP limits; throw an `HttpProblem` (429 with Retry-After) to refuse. */
  beforeAttempt(attempt: { readonly kind: AttemptKind } & Pick<SignInAttempt, "ip" | "userAgent">): void | Promise<void>;
  /**
   * The per-account+IP delay and the account lock, applied alike to identifiers that name no
   * account (T1); answer a refusal to stop before the password is checked.
   */
  beforePasswordCheck(attempt: SignInAttempt): SignInRefusal | undefined | Promise<SignInRefusal | undefined>;
  /** Every failed proof: unknown account, wrong or no password, disabled account. */
  recordFailure(attempt: SignInAttempt): void | Promise<void>;
  recordSuccess(attempt: SignInAttempt & { readonly account: AccountRecord }): void | Promise<void>;
}

/** No limits, for tests; the app uses `createSignInLimits`. */
export const openSignInGate: SignInGate = {
  beforeAttempt: () => undefined,
  beforePasswordCheck: () => undefined,
  recordFailure: () => undefined,
  recordSuccess: () => undefined,
};
