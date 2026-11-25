import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, type Page } from "@playwright/test";
import { MOCK_OIDC_CLIENT_ID, MOCK_OIDC_CLIENT_SECRET, MOCK_OIDC_ISSUER } from "./mock-oidc.ts";

/**
 * Test-only fixtures, written straight into the e2e server's SQLite database (the server reads
 * every request from it, so rows inserted here count at once). They store tokens the way the
 * server does: only the SHA-256 of a 32-byte base64url token.
 */

function e2eDirectory(): string {
  const directory = process.env["NU_E2E_DIR"];
  if (directory === undefined || directory === "") throw new Error("NU_E2E_DIR is not set: run through playwright.config.ts.");
  return directory;
}

function databaseFile(): string {
  return join(e2eDirectory(), "data", "db", "not-unreachable.sqlite");
}

function withDatabase<T>(use: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databaseFile());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return use(database);
  } finally {
    database.close();
  }
}

/** The admin smoke.spec.ts creates at first-run setup; the specs that run after it sign in as them. */
export const admin = {
  username: "ada",
  email: "ada@example.com",
  displayName: "Ada Admin",
  password: "correct horse battery staple 42",
} as const;

const newToken = (): string => randomBytes(32).toString("base64url");
const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** A first-run setup token, as `not-unreachable setup-link` issues it; answers the token for `/setup#<token>`. */
export function seedFirstRunSetupToken(): string {
  const token = newToken();
  const now = new Date();
  withDatabase((database) => {
    database.prepare("DELETE FROM setup_tokens WHERE purpose = 'first-run' AND used_at IS NULL").run();
    database
      .prepare(
        "INSERT INTO setup_tokens (id, purpose, token_hash, user_id, created_at, expires_at, used_at) VALUES (?, 'first-run', ?, NULL, ?, ?, NULL)",
      )
      .run(randomUUID(), hashToken(token), now.toISOString(), new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  });
  return token;
}

export interface SeededUser {
  readonly username: string;
  readonly displayName: string;
  /** The session token, for the `__Host-nu_session` cookie. */
  readonly sessionToken: string;
}

/**
 * A user account with a live session. In the product a user never signs in with a password, so
 * the fixture starts its session directly, as a sign-in by another method would.
 */
export function seedUserWithSession(username = "una"): SeededUser {
  const displayName = "Una User";
  const sessionToken = newToken();
  const now = new Date().toISOString();
  withDatabase((database) => {
    const userId = randomUUID();
    database
      .prepare(
        "INSERT INTO users (id, username, email, display_name, role, status, quota_bytes, created_at, disabled_at) VALUES (?, ?, ?, ?, 'user', 'active', NULL, ?, NULL)",
      )
      .run(userId, username, `${username}@example.com`, displayName, now);
    database
      .prepare(
        "INSERT INTO sessions (id, token_hash, user_id, state, created_at, last_seen_at, recent_sign_in_at, ip, user_agent, revoked_at) VALUES (?, ?, ?, 'active', ?, ?, ?, '127.0.0.1', 'e2e fixture', NULL)",
      )
      .run(randomUUID(), hashToken(sessionToken), userId, now, now, now);
  });
  return { username, displayName, sessionToken };
}

/** The id of the resource named `name`, as the admin added it. */
export function resourceIdOf(name: string): string {
  return withDatabase((database) => {
    const id = database.prepare("SELECT id FROM resources WHERE name = ?").get(name)?.["id"];
    if (typeof id !== "string") throw new Error(`No resource named ${name}.`);
    return id;
  });
}

/**
 * Records `folder` (relative to the resource's root, made on disk by the caller) as the user's
 * home, as accepting an invitation would, without needing the home root.
 */
export function seedHome(username: string, resourceId: string, folder: string): void {
  withDatabase((database) => {
    database
      .prepare("INSERT INTO homes (username, resource_id, path, created_at) VALUES (?, ?, ?, ?)")
      .run(username, resourceId, folder, new Date().toISOString());
  });
}

/**
 * Raises the per-IP sign-in limits (T11) for the run. Every spec's browser signs in from
 * 127.0.0.1, and the parallel workers together pass the default of 10 attempts a minute (an SSO
 * sign-in counts its start and its callback), which a real instance's users, each on their own
 * address, don't. The delay and lock after failures keep their defaults.
 */
export function raiseSignInLimitsForTheRun(): void {
  const signInLimits = { perIpPerMinute: 100, perIpPerHour: 1000, delayAfterFailures: 5, lockAfterFailures: 20, lockMinutes: 15 };
  withDatabase((database) => {
    database
      .prepare(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('signInLimits', ?, ?, NULL) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(signInLimits), new Date().toISOString());
  });
}

/** The session cookie for Playwright's `context.addCookies`. */
export function sessionCookie(origin: string, token: string) {
  // Host-only (no leading dot) with Path=/, as `__Host-` requires.
  return {
    name: "__Host-nu_session",
    value: token,
    domain: new URL(origin).hostname,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Strict" as const,
  };
}

/**
 * A live, active session for the admin, for specs about something other than signing in. It has
 * no recent sign-in, so an action that needs one asks for it.
 */
export function seedAdminSession(): string {
  const sessionToken = newToken();
  const now = new Date().toISOString();
  withDatabase((database) => {
    const userId = database.prepare("SELECT id FROM users WHERE username = ?").get(admin.username)?.["id"];
    if (typeof userId !== "string") throw new Error("The admin doesn't exist yet: smoke.spec.ts creates it.");
    database
      .prepare(
        "INSERT INTO sessions (id, token_hash, user_id, state, created_at, last_seen_at, recent_sign_in_at, ip, user_agent, revoked_at) VALUES (?, ?, ?, 'active', ?, ?, NULL, '127.0.0.1', 'e2e fixture', NULL)",
      )
      .run(randomUUID(), hashToken(sessionToken), userId, now, now);
  });
  return sessionToken;
}

/*
 * The admin's authenticator app, as a phone would hold it: smoke.spec.ts adds it at the first
 * sign-in and saves its key and recovery codes in the run's directory, where every worker reads
 * them. A code passes once (the server refuses a step it already took), so the specs take steps
 * from one shared, locked counter.
 */

const TOTP_PERIOD_MS = 30_000;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

interface AdminSecondFactor {
  readonly setupKey: string;
  readonly recoveryCodes: readonly string[];
  /** The last TOTP step a spec used. */
  readonly lastStep: number;
}

const stateFile = (): string => join(e2eDirectory(), "admin-second-factor.json");

function isAdminSecondFactor(value: unknown): value is AdminSecondFactor {
  if (typeof value !== "object" || value === null) return false;
  return (
    "setupKey" in value &&
    typeof value.setupKey === "string" &&
    "recoveryCodes" in value &&
    Array.isArray(value.recoveryCodes) &&
    value.recoveryCodes.every((code) => typeof code === "string") &&
    "lastStep" in value &&
    typeof value.lastStep === "number"
  );
}

function readState(): AdminSecondFactor {
  const parsed: unknown = JSON.parse(readFileSync(stateFile(), "utf8"));
  if (!isAdminSecondFactor(parsed)) throw new Error("The admin's second factor isn't saved: smoke.spec.ts adds it.");
  return parsed;
}

function writeState(state: AdminSecondFactor): void {
  writeFileSync(stateFile(), JSON.stringify(state), { mode: 0o600 });
}

/** Runs `use` holding the state file's lock: a directory, which only one worker can create. */
async function withStateLock<T>(use: () => Promise<T> | T): Promise<T> {
  const lock = join(e2eDirectory(), "admin-second-factor.lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await sleep(50);
    }
  }
  try {
    return await use();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of text.replaceAll(/[\s=]/g, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`Not base32: ${character}`);
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

const currentStep = (): number => Math.floor(Date.now() / TOTP_PERIOD_MS);

/** The 6-digit code of a 30-second step (RFC 6238 over RFC 4226, HMAC-SHA-1), as an authenticator app shows it. */
export function totpCode(setupKey: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(setupKey)).update(counter).digest();
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Saves the app smoke.spec.ts added, with the code of the step it was confirmed with. */
export function saveAdminSecondFactor(setupKey: string, recoveryCodes: readonly string[], confirmedStep: number): void {
  writeState({ setupKey, recoveryCodes, lastStep: confirmedStep });
}

/** A code for adding the app: the current step's, which counts as used from then on. */
export function enrolmentCode(setupKey: string): { readonly code: string; readonly step: number } {
  const step = currentStep();
  return { code: totpCode(setupKey, step), step };
}

/**
 * A code of the admin's app that no spec has used. The server takes the steps around its own clock
 * (one before to one after), so when the next free step is further ahead this waits for it, and
 * gives the test that long more.
 */
export async function freshAdminTotpCode(): Promise<string> {
  // The step is taken under the lock, and waited for outside it, so other workers' fixtures don't
  // wait behind this one's sleep (and run out of their own test's time).
  const { setupKey, step } = await withStateLock(() => {
    const state = readState();
    const next = Math.max(state.lastStep + 1, currentStep());
    writeState({ ...state, lastStep: next });
    return { setupKey: state.setupKey, step: next };
  });
  const waitMs = (step - 1) * TOTP_PERIOD_MS - Date.now();
  if (waitMs > 0) {
    test.info().setTimeout(test.info().timeout + waitMs + 1_000);
    // Into the step before by a second, so the server's clock is there too.
    await sleep(waitMs + 1_000);
  }
  return totpCode(setupKey, step);
}

/** Saves a screenshot into .office/screenshots/ when NU_SCREENSHOTS is set. */
export async function screenshot(page: Page, name: string): Promise<void> {
  if (process.env["NU_SCREENSHOTS"] === undefined) return;
  const directory = join(".office", "screenshots");
  mkdirSync(directory, { recursive: true });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}

/** What the second-factor step names the downloaded recovery codes. */
export const recoveryCodesFileName = "not-unreachable-recovery-codes.txt";

/** Types the password at `path` (a sign-in page), then a fresh authenticator code at the second step. */
export async function signInAsAdmin(page: Page, path = "/sign-in"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Username or email").fill(admin.username);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Two-step sign-in" })).toBeVisible();
  await page
    .getByRole("group", { name: "Authenticator code" })
    .getByRole("textbox", { name: "Digit 1 of 6" })
    .fill(await freshAdminTotpCode());
  await page.getByRole("button", { name: "Verify" }).click();
}

/** One of the admin's unused recovery codes, taken off the list. */
export async function takeAdminRecoveryCode(): Promise<string> {
  return withStateLock(() => {
    const state = readState();
    const [code, ...rest] = state.recoveryCodes;
    if (code === undefined) throw new Error("No recovery codes left.");
    writeState({ ...state, recoveryCodes: rest });
    return code;
  });
}

/** The admin's new recovery codes, after Settings regenerated them. */
export async function replaceAdminRecoveryCodes(recoveryCodes: readonly string[]): Promise<void> {
  await withStateLock(() => writeState({ ...readState(), recoveryCodes }));
}

/** What sso.spec.ts names the provider it adds for the mock (e2e/mock-oidc.ts). */
export const mockOidcProviderName = "Example Identity";

/**
 * Makes sure the mock provider (e2e/mock-oidc.ts) is a sign-in provider, as mockOidcProviderName:
 * adds it when there are no providers yet (only one provider may use an issuer). Needs a recent sign-in.
 */
export async function ensureMockOidcProvider(page: Page): Promise<void> {
  const name = mockOidcProviderName;
  await page.goto("/admin/settings/sign-in-providers");
  const existing = page.getByRole("table", { name: "Sign-in providers" }).getByRole("cell", { name, exact: true });
  const none = page.getByText("No sign-in providers yet");
  await expect(existing.or(none)).toBeVisible();
  if (await existing.isVisible()) return;
  await page.getByRole("button", { name: "Add provider" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Add provider" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("radio", { name: "OpenID Connect" }).check();
  await drawer.getByLabel("Name").fill(name);
  await drawer.getByLabel("Issuer").fill(MOCK_OIDC_ISSUER);
  await drawer.getByLabel("Client ID").fill(MOCK_OIDC_CLIENT_ID);
  await drawer.getByLabel("Client secret").fill(MOCK_OIDC_CLIENT_SECRET);
  await drawer.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByText("Provider added")).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

/**
 * Adds the local folder `folder` as a resource named `name` and makes `subfolder` of it the home
 * root, set for the first time or changed. Needs a recent sign-in.
 */
export async function setHomeRoot(page: Page, name: string, folder: string, subfolder = "homes"): Promise<void> {
  await page.goto("/admin/resources");
  await page.getByRole("button", { name: "Add resource" }).first().click();
  await page.getByRole("menuitem", { name: "Local folder" }).click();
  const drawer = page.getByRole("dialog", { name: "Add folder" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Name").fill(name);
  await drawer.getByLabel("Folder path").fill(folder);
  await drawer.getByRole("button", { name: "Check folder" }).click();
  await expect(drawer.getByText("The service can use this folder")).toBeVisible();
  await drawer.getByRole("button", { name: "Add folder" }).click();
  await expect(page.getByText("Folder added")).toBeVisible();
  await expect(drawer).toBeHidden();

  await page.getByRole("radiogroup", { name: "Home root" }).getByRole("radio", { name }).check();
  await page.getByLabel("Subfolder").fill(subfolder);
  await page.getByRole("button", { name: "Save home root" }).click();
  const confirm = page.getByRole("dialog", { name: /^(Set|Change) the home root\?$/ });
  await confirm.getByRole("button", { name: "Save home root" }).click();
  await expect(page.getByText("Home root saved")).toBeVisible();
  await expect(confirm).toBeHidden();
}

/** What Chromium logs when the CSP or Trusted Types block something. */
const violationPattern = /content security policy|refused to|trusted ?type|trustedhtml|trustedscript/i;

declare global {
  interface Window {
    nuReportCspViolation?: (description: string) => void;
  }
}

/** Collects every CSP violation and page error, from the console, uncaught errors and the DOM event. */
export async function watchViolations(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (violationPattern.test(message.text())) problems.push(`console ${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    problems.push(`page error: ${error.message}`);
  });
  await page.exposeFunction("nuReportCspViolation", (description: string) => {
    problems.push(`securitypolicyviolation: ${description}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.nuReportCspViolation?.(
        `${event.effectiveDirective} blocked ${event.blockedURI || "inline"} (${event.sourceFile}:${event.lineNumber})`,
      );
    });
  });
  return problems;
}

/** Waits for late chunks, styles and reports, then expects no CSP violation or page error so far. */
export async function expectNoViolations(page: Page, problems: readonly string[]): Promise<void> {
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
}
