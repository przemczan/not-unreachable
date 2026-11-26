import { routes, type RouteTable } from "@not-unreachable/contracts";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { registerApiNoStore } from "./http/api-no-store.ts";
import { registerCsrfChecks } from "./http/csrf.ts";
import { frameworkErrorHandler, registerErrorHandler } from "./http/error-handler.ts";
import { registerHttpsOnly } from "./http/https-only.ts";
import { registerNotFound } from "./http/not-found.ts";
import { registerGlobalRateLimit } from "./http/rate-limit.ts";
import { registerRequestContext } from "./http/request-context.ts";
import { registerRoutes, RouteRegistrationError, type RouteHandlers } from "./http/routes.ts";
import { registerSecurityHeaders, securityHeaders } from "./http/security-headers.ts";
import { registerStaticWeb } from "./http/static-web.ts";
import { createAccountsHandlers } from "./modules/accounts/index.ts";
import { createAuditHandlers } from "./modules/audit/index.ts";
import { createDashboardHandlers } from "./modules/dashboard/index.ts";
import { createFilesHandlers } from "./modules/files/index.ts";
import { healthHandlers } from "./modules/health/index.ts";
import { createInvitationsHandlers, registerLinkPageLimit } from "./modules/invitations/index.ts";
import { createMailHandlers } from "./modules/mail/index.ts";
import type { Clock, Config, Logger } from "./modules/platform/index.ts";
import { createAllowFolderHandlers, createResourcesHandlers } from "./modules/resources/index.ts";
import { createPasskeysHandlers, createSecondFactorsHandlers } from "./modules/second-factors/index.ts";
import { createSecuritySettingsHandlers } from "./modules/security-settings/index.ts";
import { createSessionsHandlers, registerSessionGuard } from "./modules/sessions/index.ts";
import { createShareLinksHandlers, registerShareLinkHooks } from "./modules/share-links/index.ts";
import { createSecondFactorStepHandlers, createSignInHandlers } from "./modules/sign-in/index.ts";
import { createSsoHandlers } from "./modules/sso/index.ts";
import { createCheckForUpdatesHandlers, createInstallUpdateHandlers, createUpdatesHandlers } from "./modules/updates/index.ts";
import type { AppServices } from "./services.ts";

export const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The routes registered only while a config switch is on: off, they don't exist, so they answer the
 * 404 of any unknown path to every caller.
 */
const { allowFolder: allowFolderRoute, checkForUpdates: checkForUpdatesRoute, installUpdate: installUpdateRoute, ...alwaysRoutes } = routes;

/** Registers `allowFolder` while `ALLOW_FOLDERS_FROM_UI` is on; the services must then have been made with it. */
function registerAllowFolder(app: FastifyInstance, config: Config, services: AppServices): void {
  if (!config.allowFoldersFromUi) return;
  if (services.allowedFolders === undefined) {
    throw new RouteRegistrationError("ALLOW_FOLDERS_FROM_UI is on, but the services were made without allowing folders");
  }
  registerRoutes(app, { allowFolder: allowFolderRoute }, createAllowFolderHandlers(services.allowedFolders));
}

/**
 * Registers `checkForUpdates` while `UPDATE_CHECK` is on and `installUpdate` while `UPDATE_FROM_UI`
 * is on; the services must have been made with the same switches.
 */
function registerUpdates(app: FastifyInstance, config: Config, services: AppServices): void {
  if (services.updates.checkEnabled !== config.updateCheck || services.updates.installEnabled !== config.updateFromUi) {
    throw new RouteRegistrationError("UPDATE_CHECK or UPDATE_FROM_UI differ between the config and the services");
  }
  if (config.updateCheck) {
    registerRoutes(app, { checkForUpdates: checkForUpdatesRoute }, createCheckForUpdatesHandlers(services.updates));
  }
  if (config.updateFromUi) registerRoutes(app, { installUpdate: installUpdateRoute }, createInstallUpdateHandlers(services.updates));
}

/** More routes, registered through the same contract checks as the real table (tests use it). */
export interface ExtraRoutes<Table extends RouteTable> {
  readonly table: Table;
  readonly handlers: RouteHandlers<Table>;
}

export interface AppDependencies<Extra extends RouteTable = RouteTable> {
  readonly logger: Logger;
  readonly services: AppServices;
  readonly clock: Clock;
  /** The built SPA's directory; without it, no static files and no SPA fallback are served. */
  readonly webRoot?: string;
  readonly extraRoutes?: ExtraRoutes<Extra>;
}

/** The composition root: the Fastify app with its security baseline and every route. It doesn't listen. */
export async function buildApp<Extra extends RouteTable = RouteTable>(
  config: Config,
  deps: AppDependencies<Extra>,
): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance,
    // Forwarded headers are believed only from these addresses (deployment.md); never `true`.
    trustProxy: [...config.trustedProxies],
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: false,
    return503OnClosing: true,
    requestTimeout: 120_000,
    keepAliveTimeout: 65_000,
    frameworkErrors: frameworkErrorHandler(securityHeaders(config)),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Only JSON bodies parse; anything else is a 415.
  app.removeContentTypeParser("text/plain");
  registerErrorHandler(app);

  // Hooks run in this order: headers first, so every answer below carries them.
  await registerSecurityHeaders(app, config);
  registerApiNoStore(app);
  registerRequestContext(app);
  registerHttpsOnly(app, config);
  const { services, clock } = deps;
  await registerGlobalRateLimit(app, services.settings);
  registerLinkPageLimit(app, services.linkPageLimit);
  registerShareLinkHooks(app, services.shareTokenLimit);
  registerCsrfChecks(app, config);
  // After the CSRF checks, before any handler: every route of the table is guarded by its contract.
  registerSessionGuard(app, services.sessions, clock);

  registerRoutes(app, alwaysRoutes, {
    ...healthHandlers,
    ...createAccountsHandlers(services.accounts, services.setup, clock),
    ...createSignInHandlers(services.signIn, services.accounts, clock),
    ...createSecondFactorStepHandlers(services.secondFactorStep, clock),
    ...createSecondFactorsHandlers(services.secondFactors, services.accounts),
    ...createPasskeysHandlers(services.passkeys, services.accounts),
    ...createSessionsHandlers(services.sessions),
    ...createAuditHandlers(services.audit, clock),
    ...createSecuritySettingsHandlers(services.securitySettings),
    ...createResourcesHandlers(services.resources),
    ...createSsoHandlers(services.sso),
    ...createMailHandlers(services.mail, (id) => services.accounts.findById(id)?.email ?? null),
    ...createInvitationsHandlers(services),
    ...createFilesHandlers(services.files, services.uploads),
    ...createShareLinksHandlers(services.shareLinks, services.publicShareLinks),
    ...createUpdatesHandlers(services.updates),
    ...createDashboardHandlers(services.dashboard),
  });
  registerAllowFolder(app, config, services);
  registerUpdates(app, config, services);
  if (deps.extraRoutes !== undefined) {
    const clash = Object.keys(deps.extraRoutes.table).filter((name) => Object.hasOwn(routes, name));
    if (clash.length > 0) throw new RouteRegistrationError(`Extra routes clash with the route table: ${clash.join(", ")}`);
    registerRoutes(app, deps.extraRoutes.table, deps.extraRoutes.handlers);
  }

  if (deps.webRoot !== undefined) await registerStaticWeb(app, deps.webRoot);
  registerNotFound(app, { spa: deps.webRoot !== undefined });
  return app;
}
