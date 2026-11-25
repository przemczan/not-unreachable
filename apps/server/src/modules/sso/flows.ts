import { problemTypes, SSO_SIGN_IN_FAILED_PATH } from "@not-unreachable/contracts";
import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import { HttpProblem } from "../../http/index.ts";
import type { AuditDetails } from "../audit/index.ts";
import { hashToken, MINUTE_MS, newId, newToken, type Clock, type EnvelopeAad, type Secrets } from "../platform/index.ts";
import { clearedSsoCookie, readSsoToken, ssoCookie } from "./cookie.ts";
import {
  DiscoveryFailedError,
  type AuthorizationParameters,
  type ProviderEndpoint,
  type SsoIdentity,
  type SsoProtocol,
} from "./protocol.ts";
import { ssoRedirectUri, type SsoProviderRecord, type SsoProvidersService } from "./providers.ts";
import type { SsoRepository } from "./repository.ts";
import type { SsoFlowRow } from "./schema.ts";

/** A flow not finished within this time is refused, and the purge job deletes it (threat model, T9). */
export const SSO_FLOW_LIFETIME_MS = 10 * MINUTE_MS;

/** The purpose every failure without a flow of its own is reported to: the browser was most likely signing in. */
export const SIGN_IN_PURPOSE = "sign-in";

/** Why the callback refused, as `sign-in.failed` records it; the browser never sees it (T9). */
export type SsoFailureReason = Extract<AuditDetails<"sign-in.failed">, { method: "sso" }>["reason"];

/** Where a request came from; `request.requestContext` is one. */
export interface SsoOrigin {
  readonly ip: string;
  readonly userAgent: string | null;
}

/** A flow, as its purpose sees it at the callback; it is deleted already. */
export interface SsoFlow {
  readonly id: string;
  readonly purpose: string;
  readonly provider: SsoProviderRecord;
  /** Set by purposes that act for a signed-in account, such as linking. */
  readonly accountId: string | null;
  readonly sessionId: string | null;
  /** What the purpose stored at the start, such as the invitation being accepted; never a secret. */
  readonly purposeData: string | null;
}

export interface SsoFailure {
  readonly reason: SsoFailureReason;
  /** The callback's provider, when its id names one. */
  readonly providerId: string | null;
}

/** Where the callback sends the browser (303), and any cookie it sets on the way. */
export interface SsoRedirect {
  readonly location: string;
  readonly cookies?: readonly string[];
}

/**
 * What an SSO flow is for. The sso module runs the protocol and hands the checked identity to the
 * purpose the flow was started for; signing in, linking, accepting an invitation and re-linking each
 * register one, so a new purpose never changes this module.
 */
export interface SsoPurpose {
  readonly purpose: string;
  complete(identity: SsoIdentity, flow: SsoFlow, origin: SsoOrigin): SsoRedirect | Promise<SsoRedirect>;
  /** The flow is refused; `flow` is undefined when the callback came with none (no cookie, or an unknown one). */
  failed(failure: SsoFailure, flow: SsoFlow | undefined, origin: SsoOrigin): SsoRedirect;
}

export interface SsoPurposeRegistry {
  /** Throws on a purpose registered already. */
  register(purpose: SsoPurpose): void;
  find(purpose: string): SsoPurpose | undefined;
}

export function createSsoPurposeRegistry(): SsoPurposeRegistry {
  const purposes = new Map<string, SsoPurpose>();
  return {
    register(purpose) {
      if (purposes.has(purpose.purpose)) throw new Error(`The SSO purpose ${purpose.purpose} is registered already`);
      purposes.set(purpose.purpose, purpose);
    },
    find: (purpose) => purposes.get(purpose),
  };
}

/** The per-IP limits of threat model T11; the sign-in module's gate is one. */
export interface SsoAttemptGate {
  /** Throws an `HttpProblem` (429 with Retry-After) to refuse. */
  beforeAttempt(attempt: { readonly kind: "sso"; readonly ip: string; readonly userAgent: string | null }): void | Promise<void>;
}

export interface StartedFlow {
  /** The provider's authorization endpoint, with every parameter. */
  readonly url: string;
  /** The `Set-Cookie` value binding the flow to the browser. */
  readonly cookie: string;
}

export interface StartContext {
  readonly accountId?: string;
  readonly sessionId?: string;
  /** The purpose's own JSON, handed back at the callback; it is stored in the clear, so never a secret. */
  readonly purposeData?: string;
}

export interface CallbackQuery {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly iss?: string | undefined;
  readonly error?: string | undefined;
}

/** A callback's answer: always a 303, always clearing the flow cookie. */
export interface SsoAnswer {
  readonly location: string;
  readonly cookies: readonly string[];
}

export interface SsoFlowsService {
  /**
   * Starts a flow through an enabled provider for a registered purpose; undefined for an unknown or
   * disabled provider. A provider whose discovery fails answers 502 `sso-provider-unreachable`.
   */
  start(providerId: string, purpose: string, context: StartContext, origin: SsoOrigin): Promise<StartedFlow | undefined>;
  /**
   * Takes the flow the cookie binds (single use, whatever happens next), checks it, the provider and
   * its answer, then hands the identity to the flow's purpose. Every refusal goes to the purpose's
   * `failed`, with no detail for the browser.
   */
  callback(providerId: string, query: CallbackQuery, cookieHeader: string | undefined, origin: SsoOrigin): Promise<SsoAnswer>;
  /** Deletes the flows past their lifetime; answers how many. */
  purgeExpired(): number;
}

export interface SsoFlowsDependencies {
  readonly repository: SsoRepository;
  readonly providers: SsoProvidersService;
  readonly protocol: SsoProtocol;
  readonly purposes: SsoPurposeRegistry;
  readonly secrets: Secrets | undefined;
  readonly clock: Clock;
  readonly publicOrigin: string;
  readonly gate: SsoAttemptGate;
}

const codeVerifierAad = (id: string): EnvelopeAad => ({ table: "sso_flows", column: "code_verifier", rowId: id });

/** Every callback's answer clears the flow cookie, whatever the purpose chose. */
function answer(redirect: SsoRedirect): SsoAnswer {
  return { location: redirect.location, cookies: [clearedSsoCookie(), ...(redirect.cookies ?? [])] };
}

function toFlow(row: SsoFlowRow, provider: SsoProviderRecord): SsoFlow {
  return {
    id: row.id,
    purpose: row.purpose,
    provider,
    accountId: row.accountId,
    sessionId: row.sessionId,
    purposeData: row.purposeData,
  };
}

export function createSsoFlowsService({
  repository,
  providers,
  protocol,
  purposes,
  secrets,
  clock,
  publicOrigin,
  gate,
}: SsoFlowsDependencies): SsoFlowsService {
  const requireSecrets = (): Secrets => {
    if (secrets === undefined) throw new Error("SSO flows need the master key");
    return secrets;
  };
  const redirectUri = (providerId: string): string => ssoRedirectUri(publicOrigin, providerId);

  const authorizationUrl = async (provider: ProviderEndpoint, parameters: AuthorizationParameters): Promise<URL> => {
    try {
      return await protocol.authorizationUrl(provider, parameters);
    } catch (error) {
      if (error instanceof DiscoveryFailedError) {
        const detail = "The provider could not be reached. Try again later.";
        throw new HttpProblem(502, problemTypes.ssoProviderUnreachable, detail, {}, {}, { cause: error });
      }
      throw error;
    }
  };

  const refuse = (failure: SsoFailure, flow: SsoFlow | undefined, origin: SsoOrigin): SsoAnswer => {
    const purpose = purposes.find(flow?.purpose ?? SIGN_IN_PURPOSE) ?? purposes.find(SIGN_IN_PURPOSE);
    return answer(purpose === undefined ? { location: SSO_SIGN_IN_FAILED_PATH } : purpose.failed(failure, flow, origin));
  };

  return {
    async start(providerId, purpose, context, origin) {
      if (purposes.find(purpose) === undefined) throw new Error(`No SSO purpose ${purpose} is registered`);
      await gate.beforeAttempt({ kind: "sso", ip: origin.ip, userAgent: origin.userAgent });
      const provider = providers.endpointOf(providerId);
      if (provider === undefined || !provider.enabled) return undefined;

      const id = newId(clock);
      const token = newToken();
      const codeVerifier = randomPKCECodeVerifier();
      const state = randomState();
      const nonce = provider.kind === "github" ? null : randomNonce();
      const url = await authorizationUrl(provider, {
        redirectUri: redirectUri(provider.id),
        state,
        nonce,
        codeChallenge: await calculatePKCECodeChallenge(codeVerifier),
      });
      const now = clock.now();
      repository.insertFlow({
        id,
        providerId: provider.id,
        purpose,
        bindingHash: hashToken(token),
        state,
        nonce,
        codeVerifier: requireSecrets().encrypt("sso", codeVerifierAad(id), codeVerifier),
        accountId: context.accountId ?? null,
        sessionId: context.sessionId ?? null,
        purposeData: context.purposeData ?? null,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SSO_FLOW_LIFETIME_MS).toISOString(),
      });
      return { url: url.href, cookie: ssoCookie(token) };
    },

    async callback(providerId, query, cookieHeader, origin) {
      // The per-IP limit answers its 429 here too, not a redirect: the flow stays for a retry once the
      // limit passes, and someone hammering the callback learns nothing they couldn't from the start route.
      await gate.beforeAttempt({ kind: "sso", ip: origin.ip, userAgent: origin.userAgent });
      const token = readSsoToken(cookieHeader);
      const row = token === undefined ? undefined : repository.takeFlow(hashToken(token));
      const provider = providers.endpointOf(providerId);
      if (provider === undefined) {
        const flowProvider = row === undefined ? undefined : providers.find(row.providerId);
        return refuse(
          { reason: "unknown-provider", providerId: null },
          row === undefined || flowProvider === undefined ? undefined : toFlow(row, flowProvider),
          origin,
        );
      }
      const failure = (reason: SsoFailureReason): SsoFailure => ({ reason, providerId: provider.id });
      if (row === undefined) return refuse(failure("invalid-flow"), undefined, origin);

      const flow = toFlow(row, provider);
      const expired = Date.parse(row.expiresAt) <= clock.now().getTime();
      if (row.providerId !== provider.id || query.state !== row.state || expired) return refuse(failure("invalid-flow"), flow, origin);
      if (!provider.enabled) return refuse(failure("disabled-provider"), flow, origin);
      if (query.error !== undefined || query.code === undefined) return refuse(failure("provider-error"), flow, origin);

      let identity: SsoIdentity;
      try {
        identity = await protocol.exchange(provider, {
          redirectUri: redirectUri(provider.id),
          code: query.code,
          state: query.state,
          iss: query.iss,
          expectedState: row.state,
          expectedNonce: row.nonce,
          codeVerifier: requireSecrets().decrypt("sso", codeVerifierAad(row.id), row.codeVerifier),
        });
      } catch {
        return refuse(failure("invalid-response"), flow, origin);
      }
      const purpose = purposes.find(row.purpose);
      if (purpose === undefined) return refuse(failure("invalid-flow"), flow, origin);
      return answer(await purpose.complete(identity, flow, origin));
    },

    purgeExpired() {
      return repository.deleteFlowsExpiredBy(clock.now().toISOString());
    },
  };
}
