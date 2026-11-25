import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { problemTypes, routes, type AuditAction, type SecondFactorStep, type TotpEnrolment } from "@not-unreachable/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "./app.ts";
import { runCli, type CliIo, type Input } from "./cli.ts";
import { SETUP_TOKEN_LIFETIME_MS } from "./modules/accounts/index.ts";
import { totpCodeForStep, totpStepAt } from "./modules/second-factors/index.ts";
import {
  createSecrets,
  hashToken,
  openDatabase,
  SecretDecryptionError,
  type Database,
  type EnvelopeColumn,
} from "./modules/platform/index.ts";
import type { AppServices } from "./services.ts";
import {
  createSoftwarePasskey,
  createTestServices,
  enrolPasskeyAtSignIn,
  expectProblem,
  fakeClock,
  goodPassword,
  makeTempDir,
  migrationsWithExtra,
  sameOriginWrite,
  sessionCookieHeader,
  sessionTokenFrom,
  silentLogger,
  testConfig,
  viaProxy,
  type FakeClock,
} from "./test-support/index.ts";

const storedRows = z.array(z.object({ id: z.string(), smb_password: z.string(), totp_seed: z.string().nullable() }));

const firstRun = (token: string) => ({
  token,
  username: "root.admin",
  email: "root@example.com",
  displayName: "Root",
  password: goodPassword,
});

/** A terminal on which the operator types `typed`, or nothing. */
function terminal(typed?: string): Input {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  input.end(typed === undefined ? undefined : `${typed}\n`);
  return input;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe("not-unreachable CLI", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let dataDir: string;
  let clock: FakeClock;
  let environment: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempDir();
    dataDir = join(temp.dir, "data");
    clock = fakeClock();
    environment = { PUBLIC_ORIGIN: "https://files.example.com", DATA_DIR: dataDir, LOG_LEVEL: "warn" };
  });
  afterEach(() => temp.cleanup());

  async function run(argv: string[], extra: Partial<CliIo> = {}): Promise<Run> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, {
      environment,
      clock,
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      ...extra,
    });
    return { code, stdout, stderr };
  }

  const backupsDir = (): string => join(dataDir, "backups");
  /** Makes a folder in the temp dir; answers its real path. */
  const folder = (name: string): string => {
    const path = join(temp.dir, name);
    mkdirSync(path, { recursive: true });
    return realpathSync(path);
  };
  const databaseFile = (): string => join(dataDir, "db", "not-unreachable.sqlite");

  it("prints usage and exits 2 without a command or with an unknown one", async () => {
    expect(await run([])).toMatchObject({ code: 2, stderr: expect.stringContaining("Usage: not-unreachable") });
    expect(await run(["frobnicate"])).toMatchObject({ code: 2, stderr: expect.stringContaining("Unknown command: frobnicate") });
    expect(await run(["--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage:") });
  });

  describe("allow-folder", () => {
    let dropInDir: string;
    let systemctlLog: string;
    let systemd: NonNullable<CliIo["systemd"]>;

    beforeEach(() => {
      dropInDir = join(temp.dir, "etc", "not-unreachable.service.d");
      systemctlLog = join(temp.dir, "systemctl.log");
      const script = join(temp.dir, "fake-systemctl.mjs");
      writeFileSync(
        script,
        'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\\n");\n',
      );
      systemd = { dropInDir, systemctl: { command: process.execPath, args: [script, systemctlLog] } };
    });

    const allow = (args: string[], extra: Partial<CliIo> = {}) => run(["allow-folder", ...args], { isRoot: true, systemd, ...extra });
    const dropIn = (): string => readFileSync(join(dropInDir, "resources.conf"), "utf8");
    const systemctlCalls = (): unknown[] =>
      existsSync(systemctlLog)
        ? readFileSync(systemctlLog, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line): unknown => JSON.parse(line))
        : [];

    it("adds the folder's real path to the drop-in, then reloads systemd and restarts the service", async () => {
      const files = folder("my files");
      symlinkSync(files, join(temp.dir, "alias"));
      const result = await allow([join(temp.dir, "alias")]);
      expect(result).toEqual({
        code: 0,
        stdout:
          `Added ${files} to ${join(dropInDir, "resources.conf")}.\n` +
          `Reloaded systemd and restarted not-unreachable.service: the service can now write to ${files}.\n`,
        stderr: "",
      });
      expect(dropIn()).toBe(
        "# Managed by `not-unreachable allow-folder`, which rewrites this file: add folders with it, not by hand.\n" +
          "# The local folders mapped as resources, which the service may write to (ProtectSystem=strict).\n" +
          "[Service]\n" +
          `ReadWritePaths="${files}"\n`,
      );
      expect(systemctlCalls()).toEqual([["daemon-reload"], ["restart", "not-unreachable.service"]]);
    });

    it("is idempotent: the same folder again leaves the drop-in as it was", async () => {
      const files = folder("files");
      expect((await allow([files])).code).toBe(0);
      const before = dropIn();
      const again = await allow([files]);
      expect(again).toMatchObject({ code: 0, stdout: expect.stringContaining(`${files} is already in`) });
      expect(dropIn()).toBe(before);
      expect(before.match(/ReadWritePaths=/g)).toHaveLength(1);

      const more = folder("more");
      expect((await allow([more])).code).toBe(0);
      expect(dropIn()).toContain(`ReadWritePaths=${files}\nReadWritePaths=${more}\n`);
    });

    it("refuses a missing folder, a file, a relative path and one overlapping the data directory, writing nothing", async () => {
      writeFileSync(join(temp.dir, "file"), "x");
      mkdirSync(join(dataDir, "inner"), { recursive: true });
      const cases = [
        [join(temp.dir, "nope"), "no folder exists at that path."],
        [join(temp.dir, "file"), "that path is not a folder."],
        ["relative/path", "the path must be absolute (start with /)."],
        [join(dataDir, "inner"), "the folder overlaps the service's data directory."],
        [temp.dir, "the folder overlaps the service's data directory."],
      ] as const;
      for (const [path, message] of cases) {
        expect(await allow([path])).toEqual({ code: 1, stdout: "", stderr: `allow-folder: ${message} Nothing changed.\n` });
      }
      expect(existsSync(dropInDir)).toBe(false);
      expect(systemctlCalls()).toEqual([]);
    });

    it("refuses to run unless as root", async () => {
      expect(await allow([folder("files")], { isRoot: false })).toEqual({
        code: 1,
        stdout: "",
        stderr: "allow-folder: run it as root, such as with sudo. Nothing changed.\n",
      });
      expect(existsSync(dropInDir)).toBe(false);
      expect(systemctlCalls()).toEqual([]);
    });

    it("needs exactly one path", async () => {
      expect(await allow([])).toMatchObject({ code: 2, stderr: expect.stringContaining("usage: not-unreachable allow-folder <path>") });
      expect(await allow(["/a", "/b"])).toMatchObject({ code: 2 });
    });
  });

  describe("setup-link and reset-admin", () => {
    let database: Database;
    let services: AppServices;
    let app: FastifyInstance;

    beforeEach(async () => {
      const migrated = await run(["migrate"]);
      if (migrated.code !== 0) throw new Error(`migrate failed: ${migrated.stderr}`);
      database = openDatabase(databaseFile());
      services = createTestServices(database, clock);
      app = await buildApp(testConfig(), { logger: silentLogger, services, clock });
      await app.ready();
    });
    afterEach(async () => {
      await app.close();
      database.sqlite.close();
    });

    const linkPattern = /^ {2}https:\/\/files\.example\.com\/setup#([A-Za-z0-9_-]{43})$/m;
    const tokenIn = (result: Run): string => {
      const token = linkPattern.exec(result.stdout)?.[1];
      if (token === undefined) throw new Error(`No setup link in: ${result.stdout}${result.stderr}`);
      return token;
    };
    const setupTokens = () => database.sqlite.prepare("SELECT * FROM setup_tokens ORDER BY created_at").all();
    const audited = (action: AuditAction) => services.audit.list({ limit: 50, action }).events;
    const post = (payload: object) => app.inject({ method: "POST", url: routes.setup.path, headers: sameOriginWrite, payload });
    const signIn = (password: string) =>
      app.inject({ method: "POST", url: routes.signIn.path, headers: sameOriginWrite, payload: { identifier: "root.admin", password } });
    // The session the password starts is pending its second factor, which can read itself.
    const profile = (cookie: string) => app.inject({ method: "GET", url: routes.getSession.path, headers: { ...viaProxy, cookie } });
    const write = (url: string, cookie: string, payload?: object) =>
      app.inject({ method: "POST", url, headers: { ...sameOriginWrite, cookie }, ...(payload === undefined ? {} : { payload }) });
    const secondStep = async (cookie: string) =>
      (
        await app.inject({ method: "GET", url: routes.getSecondFactorStep.path, headers: { ...viaProxy, cookie } })
      ).json<SecondFactorStep>();

    /** Enrols an authenticator app at the sign-in step of a pending session. */
    async function enrolTotp(cookie: string): Promise<void> {
      const { id, setupKey } = (await write(routes.startTotpEnrolment.path, cookie)).json<TotpEnrolment>();
      const code = totpCodeForStep(setupKey, totpStepAt(clock.now()));
      expect((await write(routes.confirmTotpEnrolment.path, cookie, { id, code })).statusCode).toBe(200);
      expect((await write(routes.acknowledgeRecoveryCodes.path, cookie)).statusCode).toBe(200);
    }

    /** Creates the admin through setup-link and the setup page; answers a signed-in session's cookie. */
    async function createAdmin(): Promise<string> {
      expect((await post(firstRun(tokenIn(await run(["setup-link"]))))).statusCode).toBe(200);
      return sessionCookieHeader(sessionTokenFrom(await signIn(goodPassword)));
    }

    it("setup-link prints a one-time link whose token is stored hashed and creates the admin", async () => {
      const result = await run(["setup-link"]);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const token = tokenIn(result);
      expect(setupTokens()).toEqual([
        expect.objectContaining({
          purpose: "first-run",
          token_hash: hashToken(token),
          user_id: null,
          used_at: null,
          expires_at: "2026-11-24T11:15:00.000Z",
        }),
      ]);
      expect(JSON.stringify(setupTokens())).not.toContain(token);
      expect(audited("setup-link.issued")).toEqual([
        expect.objectContaining({ actorKind: "system", details: { purpose: "first-run", expiresAt: "2026-11-24T11:15:00.000Z" } }),
      ]);

      expect((await post(firstRun(token))).statusCode).toBe(200);
      expectProblem(await post(firstRun(token)), 404, problemTypes.notFound);
      expect((await signIn(goodPassword)).statusCode).toBe(200);
    });

    it("setup-link's token expires after an hour", async () => {
      const token = tokenIn(await run(["setup-link"]));
      clock.advance(SETUP_TOKEN_LIFETIME_MS);
      expectProblem(await post(firstRun(token)), 404, problemTypes.notFound);
    });

    it("setup-link replaces an older link", async () => {
      const older = tokenIn(await run(["setup-link"]));
      clock.advance(1000);
      const newer = tokenIn(await run(["setup-link"]));
      expect(setupTokens()).toEqual([expect.objectContaining({ token_hash: hashToken(newer) })]);
      expectProblem(await post(firstRun(older)), 404, problemTypes.notFound);
      expect((await post(firstRun(newer))).statusCode).toBe(200);
    });

    it("setup-link refuses once an admin exists", async () => {
      await createAdmin();
      const result = await run(["setup-link"]);
      expect(result).toEqual({ code: 1, stdout: "", stderr: expect.stringContaining("An admin already exists") });
      expect(audited("setup-link.issued")).toHaveLength(1);
    });

    it("reset-admin refuses when no admin exists", async () => {
      expect(await run(["reset-admin", "--yes"])).toEqual({ code: 1, stdout: "", stderr: expect.stringContaining("No admin exists yet") });
    });

    it("reset-admin needs a confirmation and changes nothing without one", async () => {
      const cookie = await createAdmin();
      const noTerminal = await run(["reset-admin"], { stdin: Object.assign(new PassThrough(), { isTTY: false }) });
      expect(noTerminal).toEqual({ code: 1, stdout: "", stderr: expect.stringContaining("pass --yes") });
      const wrongName = await run(["reset-admin"], { stdin: terminal("someone.else") });
      expect(wrongName).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("not the admin's username") });
      expect(wrongName.stderr).toContain('"root.admin"');
      const nothingTyped = await run(["reset-admin"], { stdin: terminal() });
      expect(nothingTyped).toMatchObject({ code: 1, stdout: "" });
      expect(await run(["reset-admin", "--force"])).toMatchObject({ code: 2 });

      expect((await profile(cookie)).statusCode).toBe(200);
      expect(audited("admin.reset")).toEqual([]);
      expect((await signIn(goodPassword)).statusCode).toBe(200);
    });

    it("reset-admin goes ahead once the admin's username is typed", async () => {
      await createAdmin();
      const result = await run(["reset-admin"], { stdin: terminal(" Root.Admin ") });
      expect(result.code).toBe(0);
      tokenIn(result);
      expect(audited("admin.reset")).toHaveLength(1);
    });

    it("reset-admin --yes removes the password, revokes every session and prints a one-time link to set a new one", async () => {
      const first = await createAdmin();
      const second = sessionCookieHeader(sessionTokenFrom(await signIn(goodPassword)));
      clock.advance(1000);

      const result = await run(["reset-admin", "--yes"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("signed out 2 session(s)");
      const token = tokenIn(result);

      for (const cookie of [first, second]) expect((await profile(cookie)).statusCode).toBe(401);
      expect(database.sqlite.prepare("SELECT * FROM password_credentials").all()).toEqual([]);
      expect((await signIn(goodPassword)).statusCode).toBe(401);
      const [admin] = z.tuple([z.object({ id: z.string() })]).parse(database.sqlite.prepare("SELECT id FROM users").all());
      expect(audited("admin.reset")).toEqual([
        expect.objectContaining({
          actorKind: "system",
          targetId: admin.id,
          outcome: "succeeded",
          details: { revokedSessions: 2, removedSignInMethods: ["password"] },
        }),
      ]);
      expect(audited("session.revoked")).toEqual(
        Array.from({ length: 2 }, () =>
          expect.objectContaining({ actorKind: "system", details: expect.objectContaining({ reason: "admin-reset" }) }),
        ),
      );
      expect(audited("setup-link.issued")[0]).toMatchObject({ actorKind: "system", details: { purpose: "admin-reset" } });
      expect(setupTokens()).toContainEqual(
        expect.objectContaining({ purpose: "admin-reset", token_hash: hashToken(token), user_id: admin.id }),
      );

      const newPassword = "a brand new admin password";
      expectProblem(await post(firstRun(token)), 404, problemTypes.notFound);
      const reset = await post({ token, password: newPassword });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toEqual({ username: "root.admin" });
      expect((await signIn(newPassword)).statusCode).toBe(200);
      expect((await signIn(goodPassword)).statusCode).toBe(401);
      expectProblem(await post({ token, password: "yet another admin password" }), 404, problemTypes.notFound);
    });

    it("reset-admin --second-factors asks to confirm what it removes", async () => {
      await createAdmin();
      const result = await run(["reset-admin", "--second-factors"], { stdin: terminal("someone.else") });
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain('removes the authenticator apps, passkeys and recovery codes of the admin account "root.admin"');
      const both = await run(["reset-admin", "--second-factors", "--password"], { stdin: terminal() });
      expect(both.stderr).toContain("removes the password and the authenticator apps, passkeys and recovery codes");
    });

    it("reset-admin --second-factors removes the factors, keeps the password and forces enrolment, as the system", async () => {
      const cookie = await createAdmin();
      await enrolTotp(cookie);

      const result = await run(["reset-admin", "--second-factors", "--yes"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("removed second-factors; signed out 1 session(s)");
      expect(result.stdout).toContain("set up an authenticator app");
      expect(result.stdout).not.toContain("/setup#");
      expect(database.sqlite.prepare("SELECT * FROM totp_credentials").all()).toEqual([]);
      expect(database.sqlite.prepare("SELECT * FROM recovery_codes").all()).toEqual([]);
      expect(audited("second-factor.removed")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actorKind: "system", details: { kind: "totp", reason: "reset-admin" } }),
          expect.objectContaining({ actorKind: "system", details: { kind: "recoveryCodes", reason: "reset-admin" } }),
        ]),
      );
      expect(audited("admin.reset")[0]).toMatchObject({ details: { revokedSessions: 1, removedSignInMethods: ["second-factors"] } });
      expect((await profile(cookie)).statusCode).toBe(401);

      const signedIn = await signIn(goodPassword);
      expect(signedIn.statusCode).toBe(200);
      expect(await secondStep(sessionCookieHeader(sessionTokenFrom(signedIn)))).toEqual({ mode: "enrol", methods: [] });
    });

    it("reset-admin --second-factors removes the passkeys too", async () => {
      const cookie = await createAdmin();
      const passkey = createSoftwarePasskey();
      expect(await enrolPasskeyAtSignIn({ app }, cookie, passkey)).toHaveLength(10);
      expect((await write(routes.acknowledgeRecoveryCodes.path, cookie)).statusCode).toBe(200);
      const [stored] = z.tuple([z.object({ id: z.string() })]).parse(database.sqlite.prepare("SELECT id FROM passkey_credentials").all());

      const result = await run(["reset-admin", "--second-factors", "--yes"]);
      expect(result.code).toBe(0);
      expect(database.sqlite.prepare("SELECT * FROM passkey_credentials").all()).toEqual([]);
      expect(database.sqlite.prepare("SELECT * FROM recovery_codes").all()).toEqual([]);
      expect(audited("second-factor.removed")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actorKind: "system", targetId: stored.id, details: { kind: "passkey", reason: "reset-admin" } }),
          expect.objectContaining({ actorKind: "system", details: { kind: "recoveryCodes", reason: "reset-admin" } }),
        ]),
      );
      const signedIn = await signIn(goodPassword);
      expect(await secondStep(sessionCookieHeader(sessionTokenFrom(signedIn)))).toEqual({ mode: "enrol", methods: [] });
    });

    it("reset-admin's link expires after an hour and a second reset replaces it", async () => {
      await createAdmin();
      const expired = tokenIn(await run(["reset-admin", "--yes"]));
      clock.advance(SETUP_TOKEN_LIFETIME_MS);
      expectProblem(await post({ token: expired, password: "a brand new admin password" }), 404, problemTypes.notFound);

      const older = tokenIn(await run(["reset-admin", "--yes"]));
      const newer = tokenIn(await run(["reset-admin", "--yes"]));
      expectProblem(await post({ token: older, password: "a brand new admin password" }), 404, problemTypes.notFound);
      expect((await post({ token: newer, password: "a brand new admin password" })).statusCode).toBe(200);
      expect(audited("admin.reset").map((event) => event.details)).toContainEqual({ revokedSessions: 0, removedSignInMethods: [] });
    });
  });

  it("exits 1 naming the key when the config is invalid", async () => {
    environment = { DATA_DIR: "relative/path" };
    const result = await run(["migrate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PUBLIC_ORIGIN");
    expect(result.stderr).toContain("DATA_DIR");
  });

  it("exits 2 on an unknown option", async () => {
    expect((await run(["migrate", "--force"])).code).toBe(2);
  });

  it("migrate applies the migrations, then finds nothing to do", async () => {
    const first = await run(["migrate"]);
    expect(first).toMatchObject({ code: 0, stdout: expect.stringContaining("0000_settings") });
    expect(existsSync(databaseFile())).toBe(true);
    expect(readdirSync(backupsDir())).toEqual(["pre-migration-20261124T101500000Z.sqlite"]);

    const second = await run(["migrate"]);
    expect(second).toMatchObject({ code: 0, stdout: expect.stringContaining("up to date") });
  });

  it("migrate exits non-zero when a migration fails, keeping the backup", async () => {
    expect((await run(["migrate"])).code).toBe(0);
    const broken = migrationsWithExtra(join(temp.dir, "broken"), "0001_broken", "NOT SQL AT ALL;");
    clock.advance(1000);
    const result = await run(["migrate"], { migrationsFolder: broken });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("migrate failed");
    expect(readdirSync(backupsDir()).toSorted()).toEqual([
      "pre-migration-20261124T101500000Z.sqlite",
      "pre-migration-20261124T101501000Z.sqlite",
    ]);
  });

  it("backup keeps the newest 7 scheduled backups and never touches pre-migration ones", async () => {
    for (let i = 0; i < 9; i++) {
      const result = await run(["backup"]);
      expect(result.code).toBe(0);
      clock.advance(60_000);
    }
    const files = readdirSync(backupsDir()).toSorted();
    expect(files.filter((name) => name.startsWith("pre-migration-"))).toEqual(["pre-migration-20261124T101500000Z.sqlite"]);
    expect(files.filter((name) => name.startsWith("not-unreachable-"))).toEqual(
      [2, 3, 4, 5, 6, 7, 8].map((minute) => `not-unreachable-20261124T10${String(15 + minute)}00000Z.sqlite`),
    );
  });

  it("rotate-key re-encrypts every envelope and swaps the key files", async () => {
    expect((await run(["migrate"])).code).toBe(0);
    const columns: EnvelopeColumn[] = [
      { table: "test_secrets", column: "smb_password", purpose: "smb" },
      { table: "test_secrets", column: "totp_seed", purpose: "test" },
    ];
    const credentials = join(temp.dir, "credentials");
    mkdirSync(credentials);
    const keyFile = join(credentials, "master.key");
    const oldKey = randomBytes(32);
    writeFileSync(keyFile, oldKey, { mode: 0o600 });

    const oldSecrets = createSecrets(oldKey);
    const rows = [
      { id: "row-1", smb: "smb-one", totp: "totp-one" },
      { id: "row-2", smb: "smb-two", totp: null },
    ];
    const database = openDatabase(databaseFile());
    database.sqlite.exec("CREATE TABLE test_secrets (id text PRIMARY KEY, smb_password text, totp_seed text)");
    const insert = database.sqlite.prepare("INSERT INTO test_secrets VALUES (?, ?, ?)");
    for (const row of rows) {
      insert.run(
        row.id,
        oldSecrets.encrypt("smb", { table: "test_secrets", column: "smb_password", rowId: row.id }, row.smb),
        row.totp === null ? null : oldSecrets.encrypt("test", { table: "test_secrets", column: "totp_seed", rowId: row.id }, row.totp),
      );
    }
    database.sqlite.close();

    clock.advance(1000);
    const result = await run(["rotate-key", "--key-file", keyFile], { envelopeColumns: columns });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Re-encrypted 3 secret(s)");
    expect(result.stdout).toContain("Store a copy of");
    expect(result.stdout).not.toContain(oldKey.toString("hex"));
    expect(result.stdout).not.toContain(oldKey.toString("base64"));

    expect(readFileSync(`${keyFile}.previous`).equals(oldKey)).toBe(true);
    expect(existsSync(`${keyFile}.new`)).toBe(false);
    const newKey = readFileSync(keyFile);
    expect(newKey).toHaveLength(32);
    expect(newKey.equals(oldKey)).toBe(false);
    expect(readdirSync(backupsDir())).toContain("not-unreachable-20261124T101501000Z.sqlite");

    const newSecrets = createSecrets(newKey);
    const reopened = openDatabase(databaseFile());
    try {
      const stored = storedRows.parse(reopened.sqlite.prepare("SELECT * FROM test_secrets ORDER BY id").all());
      expect(stored.map((row) => row.totp_seed === null)).toEqual([false, true]);
      for (const [index, row] of stored.entries()) {
        const aad = { table: "test_secrets", column: "smb_password", rowId: row.id };
        expect(newSecrets.decrypt("smb", aad, row.smb_password)).toBe(rows[index]?.smb);
        expect(() => oldSecrets.decrypt("smb", aad, row.smb_password)).toThrow(SecretDecryptionError);
      }
      expect(newSecrets.decrypt("test", { table: "test_secrets", column: "totp_seed", rowId: "row-1" }, stored[0]?.totp_seed ?? "")).toBe(
        "totp-one",
      );
    } finally {
      reopened.sqlite.close();
    }
  });

  it("rotate-key exits 1 naming the problem when the key file is missing", async () => {
    const result = await run(["rotate-key", "--key-file", join(temp.dir, "nope", "master.key")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });
});
