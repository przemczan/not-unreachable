import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defineRoute,
  roles,
  routes,
  sessionStates,
  type AuditAction,
  type AuditEvent,
  type Role,
  type RecoveryCodes,
  type SecondFactorStep,
  type Session,
  type SessionState,
  type TotpEnrolment,
} from "@not-unreachable/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { z } from "zod";
import { buildApp, type ExtraRoutes } from "../app.ts";
import type { RouteHandlers } from "../http/index.ts";
import type { AccountRecord, IssuedSetupToken, PasswordHashingParameters, SetupPurpose } from "../modules/accounts/index.ts";
import { createSecrets, type Clock, type Config, type Database, type Logger, type Secrets } from "../modules/platform/index.ts";
import type { MailTransportFactory } from "../modules/mail/index.ts";
import { allowFromUiOf, type ResourceRootsOptions } from "../modules/resources/index.ts";
import { TOTP_PERIOD_SECONDS, totpCodeForStep, totpCredentials, totpStepAt } from "../modules/second-factors/index.ts";
import { createSignInLimits, type SignInGate } from "../modules/sign-in/index.ts";
import { SESSION_COOKIE } from "../modules/sessions/index.ts";
import type { SsoFetch } from "../modules/sso/index.ts";
import type { UpdateHelper, UpdatesFetch, UpdatesOptions } from "../modules/updates/index.ts";
import {
  createSettingsService,
  settingsRegistry,
  type SettingKey,
  type SettingsService,
  type SettingValue,
} from "../modules/settings/index.ts";
import { createServices, type AppServices, type UploadsOptions } from "../services.ts";
import { captureLogger, fakeClock, makeTempDir, migratedMemoryDatabase, silentLogger, type FakeClock } from "./helpers.ts";

export const testOrigin = "https://files.example.com";

/** Headers a request gets from the trusted local proxy over https (inject's default address is 127.0.0.1). */
export const viaProxy = { "x-forwarded-proto": "https" } as const;

/** What a same-origin `fetch` from the SPA sends with a state-changing request. */
export const sameOriginWrite = { ...viaProxy, origin: testOrigin, "x-nu-request": "1" } as const;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicOrigin: testOrigin,
    listenHost: "127.0.0.1",
    listenPort: 8480,
    trustedProxies: ["127.0.0.1", "::1"],
    dataDir: "/nonexistent",
    logLevel: "info",
    hstsIncludeSubdomains: false,
    allowFoldersFromUi: false,
    allowedFolderPrefixes: ["/srv", "/mnt"],
    // Off unless a test turns it on, so no test asks GitHub by accident.
    updateCheck: false,
    updateFromUi: false,
    ...overrides,
  };
}

/** A built SPA in a temp directory: an index.html, a hashed asset and a dotfile. */
export function writeWebRoot(dir: string): string {
  const root = join(dir, "web");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), '<!doctype html><html><head><script type="module" src="/assets/x.js"></script></head></html>\n');
  writeFileSync(join(root, "assets", "x.js"), "export {};\n");
  writeFileSync(join(root, "robots.txt"), "User-agent: *\n");
  writeFileSync(join(root, ".secret"), "do not serve\n");
  return root;
}

/** Routes for tests, registered through the same contract checks as the real table. */
export const testRoutes = {
  testEcho: defineRoute({
    method: "POST",
    path: "/api/v1/test/echo",
    access: "public",
    recentSignIn: false,
    safe: false,
    body: z.strictObject({ text: z.string() }),
    responses: { 200: z.strictObject({ text: z.string() }) },
  }),
  testPing: defineRoute({
    method: "POST",
    path: "/api/v1/test/ping",
    access: "public",
    recentSignIn: false,
    safe: false,
    responses: { 200: z.strictObject({ pong: z.literal(true) }) },
  }),
  testCaller: defineRoute({
    method: "GET",
    path: "/api/v1/test/caller",
    access: "public",
    recentSignIn: false,
    safe: true,
    responses: {
      200: z.strictObject({
        ip: z.string(),
        protocol: z.string(),
        caller: z
          .strictObject({
            accountId: z.string(),
            username: z.string(),
            role: z.enum(roles),
            sessionId: z.string(),
            state: z.enum(sessionStates),
            recentSignInAt: z.date().nullable(),
          })
          .nullable(),
      }),
    },
  }),
  testBoom: defineRoute({
    method: "GET",
    path: "/api/v1/test/boom",
    access: "public",
    recentSignIn: false,
    safe: true,
    responses: { 200: z.strictObject({}) },
  }),
} as const;

export const SECRET_FAILURE = "cannot open /var/lib/not-unreachable/db/secret.sqlite";

export const testHandlers: RouteHandlers<typeof testRoutes> = {
  testEcho: async (request) => ({ text: request.body.text }),
  testPing: async () => ({ pong: true }),
  testCaller: async (request) => ({ ip: request.requestContext.ip, protocol: request.protocol, caller: request.requestContext.caller }),
  testBoom: async () => {
    throw new Error(SECRET_FAILURE);
  },
};

export const testExtraRoutes: ExtraRoutes<typeof testRoutes> = { table: testRoutes, handlers: testHandlers };

/** Settings that always answer the defaults, for apps built without a database. */
export const defaultSettings: SettingsService = {
  get: <K extends SettingKey>(key: K): SettingValue<K> => structuredClone(settingsRegistry[key].default),
  set: () => {
    throw new Error("defaultSettings are read-only");
  },
};

/** Cheap argon2id parameters, so tests don't spend 64 MiB and ~100 ms on every hash. */
export const testPasswordHashing: PasswordHashingParameters = { memoryCost: 64, timeCost: 1, parallelism: 1, outputLen: 32 };

/** A password that passes the rules. */
export const goodPassword = "correct horse battery staple";

/** Secrets under a fixed test master key. */
export const testSecrets: Secrets = createSecrets(Buffer.alloc(32, 7));

/** A data directory no test folder overlaps. */
export const testResourceRoots: ResourceRootsOptions = { dataDir: "/nonexistent/not-unreachable" };

/** Tests never reach GitHub: a check or download through this fails as if offline. */
export const offlineUpdatesFetch: UpdatesFetch = async () => {
  throw new TypeError("fetch failed: tests have no network");
};

/** Tests never run systemctl: the update helper answers as if polkit refused it. */
export const unavailableUpdateHelper: UpdateHelper = {
  verify: async () => ({ ok: false, reason: "switch-off" }),
  isRunning: async () => false,
};

/** The updates module, off and offline, with paths no test machine has, unless a test gives its own. */
export function testUpdatesOptions(overrides: Partial<UpdatesOptions> = {}): UpdatesOptions {
  return {
    check: false,
    fromUi: false,
    fetch: offlineUpdatesFetch,
    helper: unavailableUpdateHelper,
    runningVersion: "1.4.0",
    arch: "x64",
    ...overrides,
    paths: {
      spoolDir: "/nonexistent/not-unreachable/updates",
      requestsDir: "/nonexistent/update-requests",
      statusFile: "/nonexistent/not-unreachable-update/status.json",
      trustedKeysDir: "/nonexistent/release-signing-keys",
      ...overrides.paths,
    },
  };
}

/** How the sso module reaches providers in a test. */
export interface TestSsoOptions {
  /** Routes the providers' hosts to local fakes (`fakeProvidersFetch`); `globalThis.fetch` when left out. */
  readonly ssoFetch?: SsoFetch;
  readonly ssoDiscoveryTimeoutMs?: number;
  /** How the mail module reaches the SMTP server; nodemailer when left out. */
  readonly mailTransport?: MailTransportFactory;
  /** {@link testOrigin} when left out. */
  readonly publicOrigin?: string;
  /** Upload staging (and fake free space); under `resourceRoots.dataDir` when left out. */
  readonly uploads?: UploadsOptions;
  /** The updates module's fakes; {@link testUpdatesOptions} fill in the rest. */
  readonly updates?: Partial<UpdatesOptions>;
}

/**
 * The real services over `database`, with cheap password hashing, the real sign-in limits unless
 * `signInGate` is given, and {@link testResourceRoots} unless `resourceRoots` is.
 */
export function createTestServices(
  database: Database,
  clock: Clock,
  logger: Logger = silentLogger,
  signInGate?: SignInGate,
  resourceRoots: ResourceRootsOptions = testResourceRoots,
  sso: TestSsoOptions = {},
): AppServices {
  const settings = createSettingsService({ db: database.db, clock, logger });
  return createServices({
    db: database.db,
    clock,
    logger,
    settings,
    resourceRoots,
    secrets: testSecrets,
    passwordHashing: testPasswordHashing,
    signInGate: (services) => signInGate ?? createSignInLimits({ ...services, secrets: testSecrets }),
    publicOrigin: sso.publicOrigin ?? testOrigin,
    ...(sso.ssoFetch === undefined ? {} : { ssoFetch: sso.ssoFetch }),
    ...(sso.ssoDiscoveryTimeoutMs === undefined ? {} : { ssoDiscoveryTimeoutMs: sso.ssoDiscoveryTimeoutMs }),
    ...(sso.mailTransport === undefined ? {} : { mailTransport: sso.mailTransport }),
    ...(sso.uploads === undefined ? {} : { uploads: sso.uploads }),
    updates: testUpdatesOptions(sso.updates),
  });
}

/** Services over a fresh in-memory database, for apps built straight from `buildApp`. */
export function inMemoryServices(
  clock: Clock = fakeClock(),
  resourceRoots: Partial<ResourceRootsOptions> = {},
  updates?: Partial<UpdatesOptions>,
): { readonly services: AppServices; readonly close: () => void } {
  const temp = makeTempDir();
  const database = migratedMemoryDatabase(temp.dir, clock);
  return {
    services: createTestServices(
      database,
      clock,
      silentLogger,
      undefined,
      { ...testResourceRoots, ...resourceRoots },
      updates === undefined ? {} : { updates },
    ),
    close: () => {
      database.sqlite.close();
      temp.cleanup();
    },
  };
}

/** The `Cookie` header value that carries a session token. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/** The session token a response's `Set-Cookie` hands out; throws when there is none. */
export function sessionTokenFrom(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = values.map((value) => new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(value)).find((found) => found !== null);
  if (match?.[1] === undefined) throw new Error(`No session cookie in the response (status ${response.statusCode})`);
  return match[1];
}

export interface TestAccountOptions {
  readonly username?: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface TestSessionOptions {
  readonly state?: SessionState;
  /** Whether the session starts with a recent sign-in; true when left out. */
  readonly recentSignIn?: boolean;
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly settings: SettingsService;
  readonly services: AppServices;
  readonly database: Database;
  /** The app's clock; advance it to pass timeouts. */
  readonly clock: FakeClock;
  readonly logs: () => Record<string, unknown>[];
  /** The admin, with `goodPassword` unless given another (set straight through the service, so no audit event). */
  createAdmin(options?: TestAccountOptions & { readonly password?: string }): Promise<AccountRecord>;
  /** A user account, which has no password: users sign in only with SSO. */
  createUser(options?: TestAccountOptions): AccountRecord;
  /**
   * Signs in through the API and passes the second step: enrols an authenticator app the first
   * time, then answers its codes. Answers the `Cookie` header value of the active session.
   */
  signIn(identifier: string, password?: string): Promise<string>;
  /** Only the password step: answers the `Cookie` header value of the session pending its second factor. */
  signInWithPassword(identifier: string, password?: string): Promise<SignedInWithPassword>;
  /** Enrols an authenticator app at the sign-in step of a pending session, up to acknowledging the recovery codes. */
  enrolAtSignIn(pendingCookie: string): Promise<EnrolledAtSignIn>;
  /**
   * A right code of the account's newest authenticator app for a step not used yet, advancing the
   * clock to the next step when the current one was used.
   */
  totpCode(accountId: string): string;
  /** A session started straight through the service (any role, either state); answers its `Cookie` header value. */
  startSession(account: AccountRecord, options?: TestSessionOptions): string;
  /** A setup token, as `setup-link` (`first-run`) or `reset-admin` (`admin-reset`) would issue it. */
  issueSetupToken(purpose: SetupPurpose): IssuedSetupToken;
  /** The audit events recorded so far, newest first (events of the same millisecond in no set order), of one action when given. */
  audited(action?: AuditAction): AuditEvent[];
  close(): Promise<void>;
}

export interface SignedInWithPassword {
  readonly cookie: string;
  readonly accountId: string;
}

export interface EnrolledAtSignIn {
  /** The `Cookie` header value of the session, active now. */
  readonly cookie: string;
  readonly setupKey: string;
  readonly recoveryCodes: string[];
}

export interface TestAppOptions extends Omit<TestSsoOptions, "publicOrigin"> {
  readonly config?: Partial<Config>;
  readonly webRoot?: string;
  /** The sign-in limits; the real ones when left out, `openSignInGate` for none. */
  readonly signInGate?: SignInGate;
  /**
   * The resources' forbidden folders (and `fixRoot`, the fake helpers); {@link testResourceRoots} when
   * left out. `allowFromUi` comes from the config's `allowFoldersFromUi` and `allowedFolderPrefixes`.
   */
  readonly resourceRoots?: ResourceRootsOptions;
}

function testAccount(role: Role, options: TestAccountOptions) {
  const username = options.username ?? (role === "admin" ? "admin" : "user");
  return {
    username,
    email: options.email ?? `${username}@example.com`,
    displayName: options.displayName ?? (role === "admin" ? "The Admin" : "A User"),
    role,
  };
}

/** The real app plus {@link testRoutes}, over an in-memory, migrated database, with its log captured. */
export async function buildTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const temp = makeTempDir();
  const clock = fakeClock();
  const { logger, lines } = captureLogger("info");
  const database = migratedMemoryDatabase(temp.dir, clock);
  const config = testConfig(options.config);
  // As main.ts does: the switch's folders go to the resources module with the config's.
  const resourceRoots = { ...(options.resourceRoots ?? testResourceRoots), ...allowFromUiOf(config) };
  const services = createTestServices(database, clock, logger, options.signInGate, resourceRoots, {
    publicOrigin: config.publicOrigin,
    ...(options.ssoFetch === undefined ? {} : { ssoFetch: options.ssoFetch }),
    ...(options.ssoDiscoveryTimeoutMs === undefined ? {} : { ssoDiscoveryTimeoutMs: options.ssoDiscoveryTimeoutMs }),
    ...(options.mailTransport === undefined ? {} : { mailTransport: options.mailTransport }),
    ...(options.uploads === undefined ? {} : { uploads: options.uploads }),
    // As main.ts does: the switches go to the updates module with the config's.
    updates: { ...options.updates, check: config.updateCheck, fromUi: config.updateFromUi },
  });
  const app = await buildApp(config, {
    logger,
    services,
    clock,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    extraRoutes: testExtraRoutes,
  });
  await app.ready();

  /** One request that must succeed; throws with its answer otherwise. */
  const call = async (method: "GET" | "POST", url: string, cookie: string | null, payload?: object): Promise<LightMyRequestResponse> => {
    const response = await app.inject({
      method,
      url,
      headers: { ...(method === "GET" ? viaProxy : sameOriginWrite), ...(cookie === null ? {} : { cookie }) },
      ...(payload === undefined ? {} : { payload }),
    });
    if (response.statusCode !== 200) throw new Error(`${method} ${url} failed with ${response.statusCode}: ${response.body}`);
    return response;
  };

  const signInWithPassword = async (identifier: string, password = goodPassword): Promise<SignedInWithPassword> => {
    const response = await call("POST", routes.signIn.path, null, { identifier, password });
    return { cookie: sessionCookieHeader(sessionTokenFrom(response)), accountId: response.json<Session>().account.id };
  };

  const totpCode = (accountId: string): string => {
    const rows = database.db
      .select()
      .from(totpCredentials)
      .where(and(eq(totpCredentials.userId, accountId), isNotNull(totpCredentials.confirmedAt)))
      .all();
    const newest = rows.toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (newest === undefined) throw new Error("The account has no authenticator app");
    const lastUsedStep = Math.max(...rows.map((row) => row.lastUsedStep ?? -1));
    const step = totpStepAt(clock.now());
    if (step <= lastUsedStep) clock.advance((lastUsedStep + 1 - step) * TOTP_PERIOD_SECONDS * 1000);
    const secret = testSecrets.decrypt("totp", { table: "totp_credentials", column: "secret", rowId: newest.id }, newest.secret);
    return totpCodeForStep(secret, totpStepAt(clock.now()));
  };

  const enrolAtSignIn = async (pendingCookie: string): Promise<EnrolledAtSignIn> => {
    const { id, setupKey } = (await call("POST", routes.startTotpEnrolment.path, pendingCookie)).json<TotpEnrolment>();
    const code = totpCodeForStep(setupKey, totpStepAt(clock.now()));
    const confirmed = (await call("POST", routes.confirmTotpEnrolment.path, pendingCookie, { id, code })).json<RecoveryCodes>();
    const acknowledged = await call("POST", routes.acknowledgeRecoveryCodes.path, pendingCookie);
    return {
      cookie: sessionCookieHeader(sessionTokenFrom(acknowledged)),
      setupKey,
      recoveryCodes: confirmed.recoveryCodes,
    };
  };

  return {
    app,
    settings: services.settings,
    services,
    database,
    clock,
    logs: lines,
    createAdmin: async (accountOptions = {}) => {
      const admin = services.accounts.create(testAccount("admin", accountOptions));
      await services.accounts.setPassword(admin.id, accountOptions.password ?? goodPassword);
      return admin;
    },
    createUser: (accountOptions = {}) => services.accounts.create(testAccount("user", accountOptions)),
    signIn: async (identifier, password = goodPassword) => {
      const pending = await signInWithPassword(identifier, password);
      const step = (await call("GET", routes.getSecondFactorStep.path, pending.cookie)).json<SecondFactorStep>();
      if (step.mode === "enrol") return (await enrolAtSignIn(pending.cookie)).cookie;
      const passed = await call("POST", routes.passTotp.path, pending.cookie, { code: totpCode(pending.accountId) });
      return sessionCookieHeader(sessionTokenFrom(passed));
    },
    signInWithPassword,
    enrolAtSignIn,
    totpCode,
    startSession: (account, sessionOptions = {}) => {
      const { token } = services.sessions.start({
        account,
        state: sessionOptions.state ?? "active",
        recentSignIn: sessionOptions.recentSignIn ?? true,
        origin: { ip: "127.0.0.1", userAgent: "test" },
      });
      return sessionCookieHeader(token);
    },
    issueSetupToken: (purpose) => (purpose === "first-run" ? services.setup.issueFirstRunToken() : services.setup.issueAdminResetToken()),
    audited: (action) => services.audit.list({ limit: 200, ...(action === undefined ? {} : { action }) }).events,
    close: async () => {
      await app.close();
      database.sqlite.close();
      temp.cleanup();
    },
  };
}
