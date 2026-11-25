import type { Config } from "./config.ts";

/**
 * The only way to build an absolute URL (threat model, T15): always from `PUBLIC_ORIGIN`, never
 * from the request's `Host` or `X-Forwarded-Host`. `path` must be an absolute path on this origin.
 */
export function absoluteUrl(config: Pick<Config, "publicOrigin">, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new RangeError("absoluteUrl needs a path starting with a single /");
  }
  const url = new URL(path, config.publicOrigin);
  if (url.origin !== config.publicOrigin) throw new RangeError("absoluteUrl must stay on PUBLIC_ORIGIN");
  return url.href;
}
