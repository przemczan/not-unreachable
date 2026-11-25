import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { MOCK_OIDC_ISSUER } from "./e2e/mock-oidc.ts";

const port = 8481;
const origin = `http://localhost:${port}`;

/** Where the mock OIDC provider's self-signed certificate for localhost and its key are, in the run's directory. */
const tlsFiles = (directory: string) => ({ cert: join(directory, "tls", "localhost.crt"), key: join(directory, "tls", "localhost.key") });

/**
 * A fresh data directory and master key for each run, in one fixed place under the OS temp
 * directory. Workers load this file too: they inherit NU_E2E_DIR from the main process, so only
 * the main process (re)creates the directory.
 */
function e2eDirectory(): string {
  const existing = process.env["NU_E2E_DIR"];
  if (existing !== undefined && existing !== "") return existing;
  const directory = join(tmpdir(), "not-unreachable-e2e");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "data"), { mode: 0o700 });
  mkdirSync(join(directory, "credentials"), { mode: 0o700 });
  writeFileSync(join(directory, "credentials", "master.key"), randomBytes(32), { mode: 0o600 });
  mkdirSync(join(directory, "tls"), { mode: 0o700 });
  const tls = tlsFiles(directory);
  // prettier-ignore
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", tls.key, "-out", tls.cert,
  ], { stdio: "ignore" });
  process.env["NU_E2E_DIR"] = directory;
  return directory;
}

const directory = e2eDirectory();
const tls = tlsFiles(directory);

export default defineConfig({
  testDir: "e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  forbidOnly: process.env["CI"] !== undefined,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
  },
  projects: [
    // First-run setup creates the admin, so the smoke spec runs first, on its own; every other
    // spec signs in as that admin, in the same instance and database.
    { name: "setup", testMatch: "smoke.spec.ts", use: { ...devices["Desktop Chrome"] } },
    // The browser doesn't trust the mock OIDC provider's self-signed certificate; the app server does.
    {
      name: "chromium",
      testIgnore: ["smoke.spec.ts", "invitations.spec.ts", "passkeys.spec.ts", "files.spec.ts", "share-links.spec.ts"],
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], ignoreHTTPSErrors: true },
    },
    // Adds a sign-in provider and resources (invitations, files and share links), which the specs above expect none of when they start,
    // so it runs after them. The passkeys spec gives the admin a passkey for a while, which would
    // make the authenticator app removable in second-factor.spec.ts, so it runs here too.
    {
      name: "chromium-after",
      testMatch: ["invitations.spec.ts", "passkeys.spec.ts", "files.spec.ts", "share-links.spec.ts"],
      dependencies: ["chromium"],
      use: { ...devices["Desktop Chrome"], ignoreHTTPSErrors: true },
    },
  ],
  webServer: [
    {
      command: "node apps/server/dist/main.js",
      url: `${origin}/api/v1/health`,
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "production",
        PUBLIC_ORIGIN: origin,
        LISTEN_HOST: "127.0.0.1",
        LISTEN_PORT: String(port),
        DATA_DIR: join(directory, "data"),
        CREDENTIALS_DIRECTORY: join(directory, "credentials"),
        LOG_LEVEL: "warn",
        // Trusts the mock OIDC provider's certificate, with TLS checks still on.
        NODE_EXTRA_CA_CERTS: tls.cert,
      },
    },
    {
      command: "node e2e/mock-oidc.ts",
      url: `${MOCK_OIDC_ISSUER}/.well-known/openid-configuration`,
      ignoreHTTPSErrors: true,
      // Never reused: each run makes a new certificate, which only a fresh mock serves.
      reuseExistingServer: false,
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { NU_MOCK_OIDC_CERT: tls.cert, NU_MOCK_OIDC_KEY: tls.key },
    },
  ],
});
