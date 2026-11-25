import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { startServer, StartupError, type ServerHandle, type StartOptions } from "./main.ts";
import { fakeClock, makeTempDir, migrationsWithExtra } from "./test-support/index.ts";

const logLine = z.looseObject({ level: z.number(), msg: z.string().optional() });
const FATAL = 60;
const mainFile = fileURLToPath(new URL("./main.ts", import.meta.url));
const serverDir = fileURLToPath(new URL("..", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** A stand-in for systemd-notify: records its arguments, NOTIFY_SOCKET and whether the port accepted a connection. */
const fakeNotifier = `
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
const socket = connect(Number(process.env.FAKE_PORT), "127.0.0.1");
const done = (accepting) => {
  writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), socket: process.env.NOTIFY_SOCKET, accepting }));
  socket.destroy();
};
socket.once("connect", () => done(true));
socket.once("error", () => done(false));
`;

describe("startServer", () => {
  let temp: ReturnType<typeof makeTempDir>;
  let environment: NodeJS.ProcessEnv;
  let output: string;
  let handle: ServerHandle | undefined;
  let port: number;
  let key: Buffer;

  const logDestination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logs = () =>
    output
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => logLine.parse(JSON.parse(line)));

  beforeEach(async () => {
    temp = makeTempDir();
    output = "";
    port = await freePort();
    const credentials = join(temp.dir, "credentials");
    mkdirSync(credentials);
    key = randomBytes(32);
    writeFileSync(join(credentials, "master.key"), key);
    environment = {
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      LISTEN_PORT: String(port),
      DATA_DIR: join(temp.dir, "data"),
      CREDENTIALS_DIRECTORY: credentials,
      LOG_LEVEL: "info",
    };
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    temp.cleanup();
  });

  const start = async (options: StartOptions = {}): Promise<ServerHandle> => {
    handle = await startServer(environment, { clock: fakeClock(), logDestination, webRoot: null, ...options });
    return handle;
  };

  const expectRefusal = async (problem: RegExp, options: StartOptions = {}): Promise<void> => {
    await expect(start(options)).rejects.toBeInstanceOf(StartupError);
    const fatal = logs().filter((line) => line.level === FATAL);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.msg).toMatch(problem);
    expect(await accepts(port)).toBe(false);
  };

  it("migrates (with a pre-migration backup) before it listens, then serves", async () => {
    const server = await start();
    expect(server.port).toBe(port);

    const messages = logs().map((line) => line.msg ?? "");
    const migrated = messages.findIndex((message) => message.startsWith("Applied database migrations"));
    const listening = messages.findIndex((message) => message.startsWith("Server listening"));
    expect(migrated).toBeGreaterThanOrEqual(0);
    expect(listening).toBeGreaterThan(migrated);
    expect(readdirSync(join(temp.dir, "data", "backups"))).toEqual(["pre-migration-20261124T101500000Z.sqlite"]);
    const sqlite = new BetterSqlite3(join(temp.dir, "data", "db", "not-unreachable.sqlite"), { readonly: true });
    try {
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()).toEqual({
        name: "settings",
      });
    } finally {
      sqlite.close();
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  function auditRows(): unknown[] {
    const sqlite = new BetterSqlite3(join(temp.dir, "data", "db", "not-unreachable.sqlite"), { readonly: true });
    try {
      return sqlite.prepare("SELECT action, actor_kind, details FROM audit_events ORDER BY rowid").all();
    } finally {
      sqlite.close();
    }
  }

  it("records system.migrated when it applied migrations, and system.started with the version", async () => {
    const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"))).version;
    await (await start()).close();
    handle = undefined;
    const migrations = JSON.stringify({
      migrations: [
        "0000_settings",
        "0001_accounts_sessions_audit",
        "0002_resources",
        "0003_second_factors",
        "0004_sso",
        "0005_invitations_and_mail",
        "0006_passkeys",
        "0007_uploads",
        "0008_share_links",
        "0009_smb_shares",
        "0010_share_link_access",
        "0011_invitation_email_options",
        "0012_updates",
      ],
    });
    const started = { action: "system.started", actor_kind: "system", details: JSON.stringify({ version }) };
    expect(auditRows()).toEqual([{ action: "system.migrated", actor_kind: "system", details: migrations }, started]);

    await start();
    expect(auditRows()).toHaveLength(3);
    expect(auditRows()[2]).toEqual(started);
  });

  describe("when the machine's interfaces can't be listed, as under the unit's RestrictAddressFamilies", () => {
    beforeEach(() => {
      vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
        throw Object.assign(new Error("uv_interface_addresses returned Unknown system error 97"), {
          code: "ERR_SYSTEM_ERROR",
          errno: 97,
        });
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(["0.0.0.0", "127.0.0.1"])("listens on %s and logs one line with its host and port", async (host) => {
      environment = { ...environment, LISTEN_HOST: host };
      await start();
      expect(await accepts(port)).toBe(true);
      const listening = logs().filter((line) => line.msg?.startsWith("Server listening"));
      expect(listening.map((line) => line.msg)).toEqual([`Server listening at http://${host}:${port}`]);
    });
  });

  it("refuses to start when its port is in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      await expect(start()).rejects.toBeInstanceOf(StartupError);
      expect(logs().filter((line) => line.level === FATAL)[0]?.msg).toMatch(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("closes gracefully", async () => {
    const server = await start();
    await server.close();
    handle = undefined;
    expect(await accepts(port)).toBe(false);
  });

  it("notifies systemd only once it listens", async () => {
    const script = join(temp.dir, "fake-notify.mjs");
    const out = join(temp.dir, "notified.json");
    writeFileSync(script, fakeNotifier);
    environment = { ...environment, NOTIFY_SOCKET: "/run/systemd/notify", FAKE_PORT: String(port), FAKE_OUT: out };
    await start({ notify: { command: process.execPath, args: [script, "--ready"] } });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ argv: ["--ready"], socket: "/run/systemd/notify", accepting: true });
  });

  it("doesn't notify without NOTIFY_SOCKET", async () => {
    const script = join(temp.dir, "fake-notify.mjs");
    const out = join(temp.dir, "notified.json");
    writeFileSync(script, fakeNotifier);
    environment = { ...environment, FAKE_PORT: String(port), FAKE_OUT: out };
    await start({ notify: { command: process.execPath, args: [script, "--ready"] } });
    expect(existsSync(out)).toBe(false);
  });

  it("keeps running when the notification fails, with a warning", async () => {
    environment = { ...environment, NOTIFY_SOCKET: "/run/systemd/notify" };
    await start({ notify: { command: join(temp.dir, "missing-systemd-notify"), args: ["--ready"] } });
    expect(logs().some((line) => line.level === 40 && line.msg?.includes("Could not notify systemd"))).toBe(true);
    expect(await accepts(port)).toBe(true);
  });

  it("refuses to start on a bad config key, naming it", async () => {
    environment = { ...environment, LISTEN_PORT: "eighty" };
    await expectRefusal(/LISTEN_PORT/);
  });

  it("refuses to start without a master key", async () => {
    delete environment["CREDENTIALS_DIRECTORY"];
    await expectRefusal(/CREDENTIALS_DIRECTORY is not set/);
  });

  it("refuses to start with a 31-byte master key, and never logs the key", async () => {
    const short = randomBytes(31);
    writeFileSync(join(temp.dir, "credentials", "master.key"), short);
    await expectRefusal(/exactly 32 bytes, it holds 31/);
    for (const encoding of ["hex", "base64", "base64url", "latin1"] as const) expect(output).not.toContain(short.toString(encoding));
  });

  it("never logs a valid master key", async () => {
    await start();
    for (const encoding of ["hex", "base64", "base64url", "latin1"] as const) expect(output).not.toContain(key.toString(encoding));
  });

  it("refuses to start when a migration fails", async () => {
    const migrationsFolder = migrationsWithExtra(join(temp.dir, "migrations"), "0001_broken", "CREATE TABLE settings (x TEXT);");
    await expectRefusal(/Failed to run the query/, { migrationsFolder });
  });

  it("refuses to start without the built web app", async () => {
    await expectRefusal(/The web app is missing/, { webRoot: join(temp.dir, "no-web") });
  });
});

describe("main.ts as a process", () => {
  let temp: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    temp = makeTempDir();
  });
  afterEach(() => temp.cleanup());

  it("exits 1 with a fatal JSON line naming a bad config key", async () => {
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--conditions=@not-unreachable/source", mainFile],
        { cwd: serverDir, env: { PATH: process.env["PATH"], DATA_DIR: "relative" } },
        (error, stdout) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout }),
      );
    });
    expect(result.code).toBe(1);
    const fatal = result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => logLine.parse(JSON.parse(line)))
      .find((line) => line.level === FATAL);
    expect(fatal?.msg).toMatch(/PUBLIC_ORIGIN/);
    expect(fatal?.msg).toMatch(/DATA_DIR/);
  });

  it("closes and exits 0 on SIGTERM", async () => {
    const port = await freePort();
    const credentials = join(temp.dir, "credentials");
    mkdirSync(credentials);
    writeFileSync(join(credentials, "master.key"), randomBytes(32));
    const script = join(temp.dir, "run.mjs");
    writeFileSync(
      script,
      `import { closeOnSignals, startServer } from ${JSON.stringify(pathToFileURL(mainFile).href)};\n` +
        `closeOnSignals(await startServer(process.env, { webRoot: null }));\nconsole.error("STARTED");\n`,
    );
    const child = spawn(process.execPath, ["--conditions=@not-unreachable/source", script], {
      cwd: serverDir,
      env: {
        PATH: process.env["PATH"],
        PUBLIC_ORIGIN: `http://localhost:${port}`,
        LISTEN_PORT: String(port),
        DATA_DIR: join(temp.dir, "data"),
        CREDENTIALS_DIRECTORY: credentials,
        LOG_LEVEL: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("STARTED")) resolve();
      });
      child.once("exit", () => reject(new Error("the server exited before it started")));
    });
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(200);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 20_000);
});
