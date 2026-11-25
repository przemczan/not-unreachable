import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";
import type { Config } from "./config.ts";
import { decodeAsciiEscapes } from "./url-path.ts";

export type { Logger } from "pino";

const SECRET_FIELDS = ["password", "code", "secret", "token"] as const;

/** Redacted paths (stack.md, "Logging"): auth headers and every field named like a secret, up to three levels deep. */
export const redactedPaths: readonly string[] = [
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`, `*.*.*.${field}`]),
];

const REDACTED_SEGMENT = "<redacted>";
/** Paths whose next segment is a bearer token: share links, invitation and re-link links, as pages and API routes. */
const tokenUrlPatterns: readonly RegExp[] = [
  /^(\/s\/)[^/?#]+/,
  /^(\/api\/v1\/public\/share-links\/)[^/?#]+/,
  /^(\/invitation\/)[^/?#]+/,
  /^(\/relink\/)[^/?#]+/,
  /^(\/api\/v1\/invitations\/)[^/?#]+/,
  /^(\/api\/v1\/relink\/)[^/?#]+/,
];
/** The SSO callback, whose query holds the provider's authorization `code` and our `state`. */
const ssoCallbackPattern = /^(\/api\/v1\/sso\/[^/?#]+\/callback)\?.*$/;

/**
 * Cuts bearer tokens out of a URL (`/s/<redacted>…`, `/invitation/<redacted>`,
 * `/api/v1/public/share-links/<redacted>/…`, the SSO callback's whole query…). It matches the path
 * as the router decodes it, so `/%73/<token>` is cut too.
 */
export function redactUrl(url: string): string {
  const decoded = decodeAsciiEscapes(url);
  for (const pattern of tokenUrlPatterns) {
    if (pattern.test(decoded)) return decoded.replace(pattern, `$1${REDACTED_SEGMENT}`);
  }
  if (ssoCallbackPattern.test(decoded)) return decoded.replace(ssoCallbackPattern, `$1?${REDACTED_SEGMENT}`);
  return url;
}

/** The part of a Fastify request (or a plain Node request) the log keeps. */
interface LoggableRequest {
  readonly method?: string;
  readonly url?: string;
  readonly ip?: string;
  readonly socket?: { readonly remoteAddress?: string | undefined } | null;
}

export interface SerializedRequest {
  method: string | undefined;
  url: string | undefined;
  remoteAddress: string | undefined;
}

export function serializeRequest(request: LoggableRequest): SerializedRequest {
  return {
    method: request.method,
    url: request.url === undefined ? undefined : redactUrl(request.url),
    remoteAddress: request.ip ?? request.socket?.remoteAddress ?? undefined,
  };
}

/** pino options shared by the CLI and the server (Fastify gets the logger as `loggerInstance`). */
export function loggerOptions(config: Pick<Config, "logLevel">): LoggerOptions {
  return {
    level: config.logLevel,
    redact: { paths: [...redactedPaths], censor: "[Redacted]" },
    serializers: { req: serializeRequest },
  };
}

/** A JSON logger to stdout (journald), or to `destination` in tests. */
export function createLogger(config: Pick<Config, "logLevel">, destination?: DestinationStream): Logger {
  const options = loggerOptions(config);
  return destination === undefined ? pino(options) : pino(options, destination);
}
