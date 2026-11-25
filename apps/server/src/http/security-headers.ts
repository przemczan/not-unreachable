import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import type { Config } from "../modules/platform/index.ts";

/** The CSP of the threat model, T4, verbatim (helmet would join directives with ";" and no space). */
export const contentSecurityPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
  "manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; " +
  "require-trusted-types-for 'script'; trusted-types 'none'";

export const permissionsPolicy =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)";

const HSTS_MAX_AGE = 31_536_000;

/** The whole header set of T13, for the rare response that no hook reaches (framework errors). */
export function securityHeaders(config: Pick<Config, "hstsIncludeSubdomains">): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "strict-transport-security": `max-age=${HSTS_MAX_AGE}${config.hstsIncludeSubdomains ? "; includeSubDomains" : ""}`,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "permissions-policy": permissionsPolicy,
  };
}

/** Sends the T13 headers on every response (API, static files, errors, 404s) and nothing else of helmet's defaults. */
export async function registerSecurityHeaders(app: FastifyInstance, config: Pick<Config, "hstsIncludeSubdomains">): Promise<void> {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    originAgentCluster: false,
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: { maxAge: HSTS_MAX_AGE, includeSubDomains: config.hstsIncludeSubdomains },
    xDnsPrefetchControl: false,
    xDownloadOptions: false,
    xFrameOptions: { action: "deny" },
    xPermittedCrossDomainPolicies: false,
    xXssProtection: false,
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("content-security-policy", contentSecurityPolicy);
    reply.header("permissions-policy", permissionsPolicy);
  });
}
