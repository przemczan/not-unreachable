import { describe, expect, it } from "vitest";
import { readRepoFile } from "./support.ts";

const nginx = readRepoFile("deploy/proxy/nginx-not-unreachable.conf");
const caddyfile = readRepoFile("deploy/proxy/Caddyfile");

/** A URL of each kind that carries a bearer token: the ones the app's own logger redacts (platform/logger.ts). */
const tokenUrls = [
  "/s/tok3n",
  "/api/v1/public/share-links/tok3n/content",
  "/invitation/tok3n",
  "/relink/tok3n",
  "/api/v1/invitations/tok3n/accept",
  "/api/v1/relink/tok3n/start",
  "/api/v1/sso/0193f0c2-5d1e-7000-8000-000000000000/callback",
];
const plainUrls = ["/", "/sign-in", "/api/v1/session", "/api/v1/sso/providers", "/settings/linked-sign-ins", "/sessions"];

/** The paths nginx's map leaves out of the access log (its `$uri` is already decoded). */
function nginxSkipsLogging(path: string): boolean {
  const map = /map \$uri \$not_unreachable_loggable \{([^}]+)\}/u.exec(nginx)?.[1] ?? "";
  const patterns = [...map.matchAll(/^\s*~(\S+)\s+0;/gmu)].map((match) => new RegExp(match[1] ?? "$^", "u"));
  return patterns.some((pattern) => pattern.test(path));
}

/** The paths Caddy's `@bearer_token` matcher skips: a trailing `*` is a prefix, an inner `*` one segment. */
function caddySkipsLogging(path: string): boolean {
  const matcher = /^\s*@bearer_token path (.+)$/mu.exec(caddyfile)?.[1] ?? "";
  return matcher
    .trim()
    .split(/\s+/u)
    .some((pattern) =>
      pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : new RegExp(`^${pattern.replaceAll("*", "[^/]+")}$`, "u").test(path),
    );
}

describe("the proxy examples' access logs", () => {
  it("leave out every URL that carries a token, and only those", () => {
    expect(caddyfile).toMatch(/^\s*log_skip @bearer_token$/mu);
    expect(nginx).toMatch(/^\s*access_log \S+ combined if=\$not_unreachable_loggable;$/mu);
    for (const url of tokenUrls) {
      expect(nginxSkipsLogging(url), `nginx ${url}`).toBe(true);
      expect(caddySkipsLogging(url), `Caddy ${url}`).toBe(true);
    }
    for (const url of plainUrls) {
      expect(nginxSkipsLogging(url), `nginx ${url}`).toBe(false);
      expect(caddySkipsLogging(url), `Caddy ${url}`).toBe(false);
    }
  });
});

function directive(name: string): string[] {
  const value = new RegExp(`^\\s*${name}\\s+([^;]+);`, "mu").exec(nginx)?.[1];
  return value === undefined ? [] : value.trim().split(/[\s:]+/u);
}

describe("the nginx example", () => {
  it("speaks TLS 1.2 and 1.3 only", () => {
    expect(directive("ssl_protocols")).toEqual(["TLSv1.2", "TLSv1.3"]);
  });

  // nginx's own default (HIGH:!aNULL:!MD5) still offers TLS 1.2 suites without forward secrecy or AEAD.
  it("offers only forward-secret AEAD suites on TLS 1.2", () => {
    const ciphers = directive("ssl_ciphers");
    expect(ciphers.length).toBeGreaterThan(0);
    for (const cipher of ciphers) expect(cipher).toMatch(/^(ECDHE|DHE)-(ECDSA|RSA)-(AES(128|256)-GCM-SHA(256|384)|CHACHA20-POLY1305)$/u);
  });
});
