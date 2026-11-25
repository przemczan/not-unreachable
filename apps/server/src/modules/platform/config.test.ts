import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const minimal = { PUBLIC_ORIGIN: "https://files.example.com" };

function problemsOf(environment: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(environment);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected the config to be rejected");
}

describe("loadConfig", () => {
  it("binds to loopback on port 8480 by default", () => {
    expect(loadConfig(minimal)).toEqual({
      publicOrigin: "https://files.example.com",
      listenHost: "127.0.0.1",
      listenPort: 8480,
      trustedProxies: ["127.0.0.1", "::1"],
      dataDir: "/var/lib/not-unreachable",
      logLevel: "info",
      hstsIncludeSubdomains: false,
      allowFoldersFromUi: false,
      allowedFolderPrefixes: ["/srv", "/mnt"],
      updateCheck: true,
      updateFromUi: false,
    });
  });

  it("reads every key", () => {
    expect(
      loadConfig({
        PUBLIC_ORIGIN: "https://files.example.com:8443",
        LISTEN_HOST: "::1",
        LISTEN_PORT: "9000",
        TRUSTED_PROXIES: "10.0.0.1, 192.168.0.0/16,fd00::/8",
        DATA_DIR: "/srv/data",
        LOG_LEVEL: "debug",
        HSTS_INCLUDE_SUBDOMAINS: "true",
        ALLOW_FOLDERS_FROM_UI: "true",
        ALLOWED_FOLDER_PREFIXES: "/srv/shares, /data/media",
        UPDATE_CHECK: "false",
        UPDATE_FROM_UI: "true",
      }),
    ).toEqual({
      publicOrigin: "https://files.example.com:8443",
      listenHost: "::1",
      listenPort: 9000,
      trustedProxies: ["10.0.0.1", "192.168.0.0/16", "fd00::/8"],
      dataDir: "/srv/data",
      logLevel: "debug",
      hstsIncludeSubdomains: true,
      allowFoldersFromUi: true,
      allowedFolderPrefixes: ["/srv/shares", "/data/media"],
      updateCheck: false,
      updateFromUi: true,
    });
  });

  it("ignores variables that are not config keys", () => {
    expect(loadConfig({ ...minimal, PATH: "/usr/bin", HOME: "/root" }).publicOrigin).toBe("https://files.example.com");
  });

  it("requires PUBLIC_ORIGIN", () => {
    expect(problemsOf({}).join()).toMatch(/^PUBLIC_ORIGIN: /);
  });

  it("requires https unless the host is localhost", () => {
    expect(problemsOf({ PUBLIC_ORIGIN: "http://files.example.com" }).join()).toMatch(/PUBLIC_ORIGIN: must be https/);
    expect(loadConfig({ PUBLIC_ORIGIN: "http://localhost:5173" }).publicOrigin).toBe("http://localhost:5173");
  });

  it.each(["https://files.example.com/app", "https://files.example.com/?a=1", "https://user:pw@files.example.com", "files.example.com"])(
    "rejects %s as PUBLIC_ORIGIN",
    (origin) => {
      expect(problemsOf({ PUBLIC_ORIGIN: origin }).join()).toMatch(/^PUBLIC_ORIGIN: /);
    },
  );

  it("never trusts every proxy", () => {
    expect(problemsOf({ ...minimal, TRUSTED_PROXIES: "*" }).join()).toMatch(/TRUSTED_PROXIES: .*\* is never allowed/);
    expect(problemsOf({ ...minimal, TRUSTED_PROXIES: "127.0.0.1,*" }).join()).toMatch(/TRUSTED_PROXIES/);
  });

  it.each(["0.0.0.0/0", "::/0", "127.0.0.1,0.0.0.0/0"])("never trusts every address through a range (%s)", (proxies) => {
    expect(problemsOf({ ...minimal, TRUSTED_PROXIES: proxies }).join()).toMatch(/TRUSTED_PROXIES: .*a \/0 range is never allowed/);
  });

  it("rejects proxies that are not addresses", () => {
    expect(problemsOf({ ...minimal, TRUSTED_PROXIES: "proxy.example.com" }).join()).toMatch(/TRUSTED_PROXIES/);
  });

  it("names every bad key at once", () => {
    const problems = problemsOf({ ...minimal, LISTEN_PORT: "99999", LOG_LEVEL: "loud", DATA_DIR: "data", HSTS_INCLUDE_SUBDOMAINS: "yes" });
    expect(problems.map((problem) => problem.split(":")[0])).toEqual(["LISTEN_PORT", "DATA_DIR", "LOG_LEVEL", "HSTS_INCLUDE_SUBDOMAINS"]);
  });

  it("rejects a listen host that is not an IP address", () => {
    expect(problemsOf({ ...minimal, LISTEN_HOST: "0.0.0.0.0" }).join()).toMatch(/^LISTEN_HOST: /);
  });

  it("allows folders from the admin interface only when ALLOW_FOLDERS_FROM_UI is true", () => {
    expect(loadConfig(minimal).allowFoldersFromUi).toBe(false);
    expect(loadConfig({ ...minimal, ALLOW_FOLDERS_FROM_UI: "false" }).allowFoldersFromUi).toBe(false);
    expect(loadConfig({ ...minimal, ALLOW_FOLDERS_FROM_UI: "true" }).allowFoldersFromUi).toBe(true);
    expect(problemsOf({ ...minimal, ALLOW_FOLDERS_FROM_UI: "yes" }).join()).toMatch(/^ALLOW_FOLDERS_FROM_UI: must be true or false/);
  });

  it("asks GitHub for new releases unless UPDATE_CHECK is false", () => {
    expect(loadConfig(minimal).updateCheck).toBe(true);
    expect(loadConfig({ ...minimal, UPDATE_CHECK: "true" }).updateCheck).toBe(true);
    expect(loadConfig({ ...minimal, UPDATE_CHECK: "false" }).updateCheck).toBe(false);
    expect(problemsOf({ ...minimal, UPDATE_CHECK: "no" }).join()).toMatch(/^UPDATE_CHECK: must be true or false/);
  });

  it("installs updates from Settings only when UPDATE_FROM_UI is true", () => {
    expect(loadConfig(minimal).updateFromUi).toBe(false);
    expect(loadConfig({ ...minimal, UPDATE_FROM_UI: "false" }).updateFromUi).toBe(false);
    expect(loadConfig({ ...minimal, UPDATE_FROM_UI: "true" }).updateFromUi).toBe(true);
    expect(problemsOf({ ...minimal, UPDATE_FROM_UI: "1" }).join()).toMatch(/^UPDATE_FROM_UI: must be true or false/);
  });

  it("reads ALLOWED_FOLDER_PREFIXES as a comma-separated list, /srv and /mnt by default", () => {
    expect(loadConfig(minimal).allowedFolderPrefixes).toEqual(["/srv", "/mnt"]);
    expect(loadConfig({ ...minimal, ALLOWED_FOLDER_PREFIXES: "/data" }).allowedFolderPrefixes).toEqual(["/data"]);
    expect(loadConfig({ ...minimal, ALLOWED_FOLDER_PREFIXES: " /data , /srv/media," }).allowedFolderPrefixes).toEqual([
      "/data",
      "/srv/media",
    ]);
  });

  it.each([
    ["/", /\/ is never an allowed prefix/],
    ["/etc", /\/etc is or holds a system folder/],
    ["/srv,/var/lib", /\/var\/lib is or holds a system folder/],
    ["/srv/../etc", /"\/srv\/..\/etc" is not a normalized path/],
    ["srv", /"srv" is not an absolute path/],
    ["/srv/", /"\/srv\/" is not a normalized path/],
    [",", /must list at least one folder/],
  ])("refuses %s in ALLOWED_FOLDER_PREFIXES, naming the prefix", (prefixes, message) => {
    const problems = problemsOf({ ...minimal, ALLOWED_FOLDER_PREFIXES: prefixes });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^ALLOWED_FOLDER_PREFIXES: /);
    expect(problems[0]).toMatch(message);
  });
});
