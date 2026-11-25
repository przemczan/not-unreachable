import { isAbsolute } from "node:path";
import {
  allowedFolderPrefixProblem,
  DEFAULT_ALLOWED_FOLDER_PREFIXES,
  parseAllowedFolderPrefixes,
} from "@not-unreachable/mount-helper/folder-access";
import { z } from "zod";

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const ipAddress = z.union([z.ipv4(), z.ipv6()]);
const ipAddressOrRange = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

const publicOrigin = z
  .url({ protocol: /^https?$/, error: "must be an absolute http(s) URL" })
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === "https:" || url.hostname === "localhost", "must be https:// unless the host is localhost")
  .refine((url) => url.username === "" && url.password === "", "must not contain credentials")
  .refine((url) => url.pathname === "/" && url.search === "" && url.hash === "", "must be an origin, with no path, query or fragment")
  .transform((url) => url.origin);

const trustedProxies = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  )
  .refine((entries) => !entries.includes("*"), "must list addresses; * is never allowed")
  // A /0 range is every address: anyone could then forge X-Forwarded-For and -Proto.
  .refine((entries) => !entries.some((entry) => entry.endsWith("/0")), "must list proxies; a /0 range is never allowed")
  .pipe(z.array(ipAddressOrRange, { error: "must be a comma-separated list of IP addresses or CIDR ranges" }));

const booleanFlag = z.enum(["true", "false"], { error: "must be true or false" }).transform((value) => value === "true");

/** The rules are the folder helper's own, so the app and the helper never disagree on a prefix. */
const allowedFolderPrefixes = z
  .string()
  .transform(parseAllowedFolderPrefixes)
  .refine((prefixes) => prefixes.length > 0, "must list at least one folder")
  .superRefine((prefixes, context) => {
    for (const prefix of prefixes) {
      const problem = allowedFolderPrefixProblem(prefix);
      if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
    }
  });

/** The bootstrap config from `config.env` (deployment.md, "Config, secrets and data"). */
const configSchema = z.object({
  PUBLIC_ORIGIN: publicOrigin,
  LISTEN_HOST: ipAddress.default("127.0.0.1"),
  LISTEN_PORT: z.coerce.number().int().min(1).max(65_535).default(8480),
  TRUSTED_PROXIES: trustedProxies.default(["127.0.0.1", "::1"]),
  DATA_DIR: z.string().refine(isAbsolute, "must be an absolute path").default("/var/lib/not-unreachable"),
  LOG_LEVEL: z.enum(logLevels).default("info"),
  HSTS_INCLUDE_SUBDOMAINS: booleanFlag.default(false),
  ALLOW_FOLDERS_FROM_UI: booleanFlag.default(false),
  ALLOWED_FOLDER_PREFIXES: allowedFolderPrefixes.default([...DEFAULT_ALLOWED_FOLDER_PREFIXES]),
  UPDATE_CHECK: booleanFlag.default(true),
  UPDATE_FROM_UI: booleanFlag.default(false),
});

export type LogLevel = (typeof logLevels)[number];

export interface Config {
  /** The only source of absolute URLs, cookies' scope and the CSRF origin check. */
  readonly publicOrigin: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly trustedProxies: readonly string[];
  readonly dataDir: string;
  readonly logLevel: LogLevel;
  readonly hstsIncludeSubdomains: boolean;
  /** Whether an admin may allow a local folder from the admin interface (deployment.md); off by default. */
  readonly allowFoldersFromUi: boolean;
  /** The folders the admin interface may allow a folder below (as real paths); `/srv` and `/mnt` by default. */
  readonly allowedFolderPrefixes: readonly string[];
  /** Whether the server asks GitHub for the latest release (deployment.md, "Updating from Settings"); on by default. */
  readonly updateCheck: boolean;
  /** Whether the admin may install a newer release from Settings; off by default. */
  readonly updateFromUi: boolean;
}

const configKeys = configSchema.keyof().options;

/** Thrown when the bootstrap config is invalid; its message names every bad key. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid config: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** Reads the config keys from the environment; other variables are ignored. */
export function loadConfig(environment: NodeJS.ProcessEnv): Config {
  const input = Object.fromEntries(configKeys.map((key) => [key, emptyToUndefined(environment[key])]));
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`));
  }
  const values = result.data;
  return {
    publicOrigin: values.PUBLIC_ORIGIN,
    listenHost: values.LISTEN_HOST,
    listenPort: values.LISTEN_PORT,
    trustedProxies: values.TRUSTED_PROXIES,
    dataDir: values.DATA_DIR,
    logLevel: values.LOG_LEVEL,
    hstsIncludeSubdomains: values.HSTS_INCLUDE_SUBDOMAINS,
    allowFoldersFromUi: values.ALLOW_FOLDERS_FROM_UI,
    allowedFolderPrefixes: values.ALLOWED_FOLDER_PREFIXES,
    updateCheck: values.UPDATE_CHECK,
    updateFromUi: values.UPDATE_FROM_UI,
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}
