import type { AuditService } from "../audit/index.ts";
import { MINUTE_MS, type Clock, type Db, type JobScheduler, type Secrets } from "../platform/index.ts";
import {
  createSsoFlowsService,
  createSsoPurposeRegistry,
  type SsoAttemptGate,
  type SsoFlowsService,
  type SsoPurposeRegistry,
} from "./flows.ts";
import { createLinkedSignInsService, createLinkPurpose, type LinkedSignInsService, type LinkSessions } from "./linked-sign-ins.ts";
import { createSsoProtocol, type SsoFetch } from "./protocol.ts";
import { createSsoProvidersService, type SsoProvidersService } from "./providers.ts";
import { createSsoRepository } from "./repository.ts";

export { clearedSsoCookie, readSsoToken, SSO_COOKIE, ssoCookie } from "./cookie.ts";
export {
  SIGN_IN_PURPOSE,
  SSO_FLOW_LIFETIME_MS,
  type CallbackQuery,
  type SsoAnswer,
  type SsoAttemptGate,
  type SsoFailure,
  type SsoFailureReason,
  type SsoFlow,
  type SsoFlowsService,
  type SsoOrigin,
  type SsoPurpose,
  type SsoPurposeRegistry,
  type SsoRedirect,
  type StartContext,
  type StartedFlow,
} from "./flows.ts";
export {
  LINK_PURPOSE,
  type LinkedIdentity,
  type LinkedSignInsService,
  type LinkingAccount,
  type LinkSessions,
  type NewLink,
  type Unlinked,
} from "./linked-sign-ins.ts";
export { DiscoveryFailedError, GITHUB_ENDPOINTS, scopesOf, type SsoFetch, type SsoIdentity } from "./protocol.ts";
export {
  clientSecretAad,
  ssoRedirectUri,
  type ActionContext,
  type NewSsoProvider,
  type SsoProviderChange,
  type SsoProviderRecord,
  type SsoProvidersService,
} from "./providers.ts";
export { createSsoHandlers, type SsoHandlersDependencies, type SsoRoutes } from "./routes.ts";
export { linkedSignIns, ssoFlows, ssoProviders, type LinkedSignInRow, type SsoFlowRow, type SsoProviderRow } from "./schema.ts";

export const SSO_FLOWS_PURGE_JOB = "sso-flows-purge";

/** Discovery answers within this, or the provider is refused (a slow issuer can't hold a request up for long). */
export const DISCOVERY_TIMEOUT_MS = 5000;
/** The token, JWKS and GitHub API calls. */
export const SSO_REQUEST_TIMEOUT_MS = 10_000;

const systemFetch: SsoFetch = (url, { method, headers, body, redirect, signal }) =>
  globalThis.fetch(url, { method, headers, body: body ?? null, redirect, ...(signal === undefined ? {} : { signal }) });

/** The sso module's services, and the registry other modules add their purposes to. */
export interface SsoServices {
  readonly providers: SsoProvidersService;
  readonly flows: SsoFlowsService;
  readonly linkedSignIns: LinkedSignInsService;
  readonly purposes: SsoPurposeRegistry;
}

export interface SsoDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly secrets: Secrets | undefined;
  /** `PUBLIC_ORIGIN`, which every redirect URI is built from (threat model, T15). */
  readonly publicOrigin: string;
  /** The sessions a link flow checks at its callback. */
  readonly sessions: LinkSessions;
  /** The per-IP sign-in limits (threat model, T11). */
  readonly gate: SsoAttemptGate;
  /** Every call to a provider goes through it; `globalThis.fetch` when left out. Tests route the providers to fakes. */
  readonly fetch?: SsoFetch;
  readonly discoveryTimeoutMs?: number;
}

/** Makes the module's services and registers the `link` purpose; the sign-in module registers `sign-in`. */
export function createSsoServices({
  db,
  clock,
  audit,
  secrets,
  publicOrigin,
  sessions,
  gate,
  fetch,
  discoveryTimeoutMs,
}: SsoDependencies): SsoServices {
  const repository = createSsoRepository(db);
  const protocol = createSsoProtocol({
    fetch: fetch ?? systemFetch,
    clock,
    discoveryTimeoutMs: discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
    requestTimeoutMs: SSO_REQUEST_TIMEOUT_MS,
  });
  const providers = createSsoProvidersService({ repository, protocol, secrets, audit, clock, publicOrigin });
  const purposes = createSsoPurposeRegistry();
  const flows = createSsoFlowsService({ repository, providers, protocol, purposes, secrets, clock, publicOrigin, gate });
  const linkedSignIns = createLinkedSignInsService({ repository, audit, clock });
  purposes.register(createLinkPurpose({ repository, audit, clock, sessions }));
  return { providers, flows, linkedSignIns, purposes };
}

/** Deletes the flows past their 10 minutes every 10 minutes; the callback refuses them either way. */
export function scheduleSsoFlowsPurge(jobs: JobScheduler, flows: SsoFlowsService): void {
  jobs.register({
    name: SSO_FLOWS_PURGE_JOB,
    intervalMs: 10 * MINUTE_MS,
    firstRunAfterMs: MINUTE_MS,
    run: () => {
      flows.purgeExpired();
    },
  });
}
