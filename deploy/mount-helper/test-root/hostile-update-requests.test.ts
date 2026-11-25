import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, chown, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the checks are one file, not a module with an index.ts.
import { signingKeyId, tarballName } from "../src/release-verify.mts";
// oxlint-disable-next-line no-restricted-imports -- the helper is one file, not a module with an index.ts.
import { runUpdateHelper, UPDATE_EXIT_CODES, type RunProgram, type UpdateHelperDependencies } from "../src/update-helper.mts";
// oxlint-disable-next-line no-restricted-imports -- the test archive builder is shared with the unit tests.
import { releaseEntries, tarGz } from "../test/tar-builder.ts";

// These tests check the update helper against the real file system as root, which is how it runs.
// Run elsewhere they would prove nothing, so they fail instead of skipping.
if (process.getuid?.() !== 0) throw new Error("The hostile-request tests must run as root: sudo pnpm test:helper-root");

// The service user: anyone but root (nobody).
const SERVICE = { uid: 65534, gid: 65534 };
const REQUEST_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const FROM = "1.4.0";
const TO = "1.5.0";
const TARBALL = tarballName(TO, "x64");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY_ID = signingKeyId(publicKey);

let root: string;
let programs: string[];
let dependencies: UpdateHelperDependencies;

const requestPath = (): string => join(root, "requests", "update.json");
const spool = (): string => join(root, "data", "updates");
const workDir = (): string => join(root, "state", "work");

const fakeRun: RunProgram = async (file, args) => {
  programs.push([file, ...args].join(" "));
  return { code: 0, stdout: "inactive\n" };
};

/** A file as the service user would write it, unless told otherwise. */
async function writeOwned(path: string, content: string | Buffer, { uid = SERVICE.uid, mode = 0o600 } = {}): Promise<void> {
  await writeFile(path, content);
  await chown(path, uid, SERVICE.gid);
  await chmod(path, mode);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "update-helper-root-")));
  await chmod(root, 0o755);
  await mkdir(join(root, "requests"), { mode: 0o700 });
  await chown(join(root, "requests"), SERVICE.uid, SERVICE.gid);
  await mkdir(join(root, "data"), { mode: 0o700 });
  await chown(join(root, "data"), SERVICE.uid, SERVICE.gid);
  await mkdir(spool(), { mode: 0o700 });
  await chown(spool(), SERVICE.uid, SERVICE.gid);
  await mkdir(join(root, "state"), { mode: 0o755 });
  const release = join(root, "opt", FROM);
  await mkdir(join(release, "installer"), { recursive: true });
  await mkdir(join(release, "release-signing-keys"));
  await writeFile(join(release, "VERSION"), `${FROM}\n`);
  await writeFile(join(release, "release-signing-keys", `${KEY_ID}.pem`), publicKey.export({ format: "pem", type: "spki" }));
  await symlink(FROM, join(root, "opt", "current"));
  const config = join(root, "config.env");
  await writeFile(config, `UPDATE_FROM_UI=true\nDATA_DIR=${join(root, "data")}\n`);
  await chown(config, 0, SERVICE.gid);
  await chmod(config, 0o640);

  const tarball = tarGz(releaseEntries(`not-unreachable-${TO}-linux-x64`, TO, "x64"));
  const checksums = Buffer.from(`${createHash("sha256").update(tarball).digest("hex")}  ${TARBALL}\n`);
  await writeOwned(join(spool(), TARBALL), tarball);
  await writeOwned(join(spool(), "SHA256SUMS"), checksums);
  await writeOwned(join(spool(), "SHA256SUMS.sig"), `ed25519 ${KEY_ID} ${sign(null, checksums, privateKey).toString("base64")}\n`);
  await writeOwned(requestPath(), JSON.stringify({ requestId: REQUEST_ID, version: TO }));

  programs = [];
  dependencies = {
    requestDir: join(root, "requests"),
    configFile: config,
    stateDir: join(root, "state"),
    releaseDir: join(root, "opt"),
    rootUid: 0,
    arch: "x64",
    serviceUser: async () => SERVICE,
    run: fakeRun,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    fetch: async () => ({ status: 200 }),
    now: () => new Date("2026-11-25T14:02:11.000Z"),
    sleep: async () => undefined,
    writeError: () => undefined,
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const verify = (): Promise<number> => runUpdateHelper(["verify"], dependencies);

async function mkfifo(path: string): Promise<void> {
  await promisify(execFile)("mkfifo", ["-m", "0600", path]);
  await chown(path, SERVICE.uid, SERVICE.gid);
}

async function writtenStatus(): Promise<unknown> {
  return JSON.parse(await readFile(join(root, "state", "status.json"), "utf8"));
}

describe("the update helper as root", () => {
  it("verifies a genuine request into root's own folder, and leaves the spool for the server", async () => {
    expect(await verify()).toBe(UPDATE_EXIT_CODES.ok);
    expect(programs).toEqual(["systemctl start --no-block not-unreachable-update-apply.service"]);
    expect((await stat(workDir())).uid).toBe(0);
    expect((await stat(workDir())).mode & 0o7777).toBe(0o700);
    const copy = await stat(join(workDir(), REQUEST_ID, TARBALL));
    expect([copy.uid, copy.mode & 0o7777]).toEqual([0, 0o600]);
    const status = await stat(join(root, "state", "status.json"));
    expect([status.uid, status.mode & 0o7777]).toEqual([0, 0o644]);
    expect((await stat(join(workDir(), REQUEST_ID, "staged", `not-unreachable-${TO}-linux-x64`, "install.sh"))).uid).toBe(0);
    expect((await readdir(spool())).toSorted()).toEqual(["SHA256SUMS", "SHA256SUMS.sig", TARBALL]);
  });

  describe("the request", () => {
    it("is refused when owned by root", async () => {
      await writeOwned(requestPath(), JSON.stringify({ requestId: REQUEST_ID, version: TO }), { uid: 0 });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
      expect(programs).toEqual([]);
    });

    it("is refused as a symlink to a root-only file", async () => {
      const target = join(root, "root-only.json");
      await writeOwned(target, JSON.stringify({ requestId: REQUEST_ID, version: TO }), { uid: 0 });
      await rm(requestPath());
      await symlink(target, requestPath());
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it("is refused as a hard link to a root-owned file", async () => {
      const target = join(root, "root-owned.json");
      await writeOwned(target, JSON.stringify({ requestId: REQUEST_ID, version: TO }), { uid: 0 });
      await rm(requestPath());
      await link(target, requestPath());
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it.each([0o644, 0o640, 0o4600])("is refused with mode %o", async (mode) => {
      await writeOwned(requestPath(), JSON.stringify({ requestId: REQUEST_ID, version: TO }), { mode });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it("is refused as a FIFO, without waiting for a writer", async () => {
      await rm(requestPath());
      await mkfifo(requestPath());
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it("is refused in a folder swapped for a symlink", async () => {
      await rm(join(root, "requests"), { recursive: true });
      await mkdir(join(root, "elsewhere"));
      await writeOwned(join(root, "elsewhere", "update.json"), JSON.stringify({ requestId: REQUEST_ID, version: TO }));
      await symlink(join(root, "elsewhere"), join(root, "requests"));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.requestRefused);
    });

    it("is refused against a config.env the service user may write", async () => {
      await chmod(dependencies.configFile, 0o660);
      expect(await verify()).toBe(UPDATE_EXIT_CODES.configRefused);
    });
  });

  describe("a spool file", () => {
    it("is refused when owned by root", async () => {
      await writeOwned(join(spool(), "SHA256SUMS.sig"), await readFile(join(spool(), "SHA256SUMS.sig")), { uid: 0 });
      expect(await verify()).toBe(UPDATE_EXIT_CODES.spoolRefused);
      expect(await writtenStatus()).toMatchObject({ result: "refused", reason: "download-incomplete" });
    });

    it("is refused as a symlink, even to a file of the service user", async () => {
      const target = join(root, "data", "elsewhere.tar.gz");
      await writeOwned(target, await readFile(join(spool(), TARBALL)));
      await rm(join(spool(), TARBALL));
      await symlink(target, join(spool(), TARBALL));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.spoolRefused);
    });

    it("is refused as a symlink to a root-only file", async () => {
      await rm(join(spool(), "SHA256SUMS"));
      await symlink("/etc/shadow", join(spool(), "SHA256SUMS"));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.spoolRefused);
    });

    it("is refused as a hard link to a root-owned file", async () => {
      const target = join(root, "root-owned");
      await writeOwned(target, await readFile(join(spool(), "SHA256SUMS")), { uid: 0 });
      await rm(join(spool(), "SHA256SUMS"));
      await link(target, join(spool(), "SHA256SUMS"));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.spoolRefused);
    });

    it("is refused over its cap", async () => {
      await writeOwned(join(spool(), "SHA256SUMS"), Buffer.alloc(16 * 1024 + 1, 0x61));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.spoolRefused);
    });

    it("is refused as a FIFO, without waiting for a writer", async () => {
      await rm(join(spool(), "SHA256SUMS.sig"));
      await mkfifo(join(spool(), "SHA256SUMS.sig"));
      expect(await verify()).toBe(UPDATE_EXIT_CODES.spoolRefused);
    });

    it("is refused in a spool folder swapped for a symlink", async () => {
      const elsewhere = join(root, "data", "elsewhere");
      await rm(spool(), { recursive: true });
      await mkdir(elsewhere, { mode: 0o700 });
      await chown(elsewhere, SERVICE.uid, SERVICE.gid);
      await symlink(elsewhere, spool());
      expect(await verify()).toBe(UPDATE_EXIT_CODES.spoolRefused);
      expect(await readdir(workDir())).toEqual([]);
    });
  });
});
