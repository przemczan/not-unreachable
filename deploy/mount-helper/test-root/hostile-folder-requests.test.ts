import { chmod, chown, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the shared rules are one file, not a module with an index.ts.
import { overlaps, SYSTEM_FOLDERS } from "../src/folder-access.mts";
// oxlint-disable-next-line no-restricted-imports -- the helper is one file, not a module with an index.ts.
import { EXIT_CODES, runHelper, type ExecFile, type HelperDependencies } from "../src/folder-helper.mts";

// These tests check the folder helper against the real file system as root, which is how it runs.
// Run elsewhere they would prove nothing, so they fail instead of skipping.
if (process.getuid?.() !== 0) throw new Error("The hostile-request tests must run as root: sudo pnpm test:helper-root");

// The service user: anyone but root (nobody).
const SERVICE = { uid: 65534, gid: 65534 };

let root: string;
let programs: string[];
let dependencies: HelperDependencies;

const srv = (): string => join(root, "srv");
const requestPath = (): string => join(root, "requests", "allow-folder.json");
const dropIn = (): string => join(root, "drop-in", "resources.conf");

const fakeExecFile: ExecFile = async (file) => {
  programs.push(file);
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "folder-helper-root-")));
  await chmod(root, 0o755);
  await mkdir(join(root, "requests"), { mode: 0o700 });
  await chown(join(root, "requests"), SERVICE.uid, SERVICE.gid);
  await mkdir(join(root, "drop-in"), { mode: 0o755 });
  await mkdir(join(root, "outside"));
  await mkdir(srv());
  const config = join(root, "config.env");
  await writeFile(config, `ALLOW_FOLDERS_FROM_UI=true\nALLOWED_FOLDER_PREFIXES=${srv()}\nDATA_DIR=${join(root, "data")}\n`);
  await chown(config, 0, SERVICE.gid);
  await chmod(config, 0o640);
  programs = [];
  dependencies = {
    requestDir: join(root, "requests"),
    configFile: config,
    dropInDir: join(root, "drop-in"),
    releaseDir: join(root, "release"),
    mountRoot: join(root, "mounts"),
    rootUid: 0,
    // The temp dir lies in /tmp, a system folder.
    systemFolders: SYSTEM_FOLDERS.filter((folder) => !overlaps(root, folder)),
    serviceUser: async () => SERVICE,
    execFile: fakeExecFile,
    writeError: () => undefined,
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A file as the service user would write it, unless told otherwise. */
async function writeOwned(path: string, content: unknown, { uid = SERVICE.uid, mode = 0o600 } = {}): Promise<void> {
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  await chown(path, uid, SERVICE.gid);
  await chmod(path, mode);
}

const allow = (): Promise<number> => runHelper(["allow"], dependencies);

async function dropInExists(): Promise<boolean> {
  return stat(dropIn()).then(
    () => true,
    () => false,
  );
}

describe("the folder helper as root", () => {
  it("allows a genuine request, and leaves the request for the server to delete", async () => {
    await mkdir(join(srv(), "media"));
    await writeOwned(requestPath(), { path: join(srv(), "media") });
    expect(await allow()).toBe(EXIT_CODES.ok);
    expect(await readFile(dropIn(), "utf8")).toContain(`ReadWritePaths=${join(srv(), "media")}\n`);
    expect((await stat(dropIn())).uid).toBe(0);
    expect((await stat(dropIn())).mode & 0o7777).toBe(0o644);
    expect(programs).toEqual(["systemctl", "systemd-run"]);
    expect((await stat(requestPath())).isFile()).toBe(true);
  });

  it("resolves a folder below one only root may enter", async () => {
    await mkdir(join(srv(), "private", "media"), { recursive: true });
    await chmod(join(srv(), "private"), 0o700);
    await writeOwned(requestPath(), { path: join(srv(), "private", "media") });
    expect(await allow()).toBe(EXIT_CODES.ok);
  });

  it("refuses a request owned by root", async () => {
    await mkdir(join(srv(), "media"));
    await writeOwned(requestPath(), { path: join(srv(), "media") }, { uid: 0 });
    expect(await allow()).toBe(EXIT_CODES.requestRefused);
    expect(await dropInExists()).toBe(false);
  });

  it("refuses a symlink to a root-only file", async () => {
    const target = join(root, "root-only.json");
    await writeOwned(target, { path: srv() }, { uid: 0 });
    await symlink(target, requestPath());
    expect(await allow()).toBe(EXIT_CODES.requestRefused);
    expect(programs).toEqual([]);
  });

  it("refuses a hard link to a root-owned file", async () => {
    const target = join(root, "root-owned.json");
    await writeOwned(target, { path: srv() }, { uid: 0 });
    await link(target, requestPath());
    expect(await allow()).toBe(EXIT_CODES.requestRefused);
  });

  it.each([0o644, 0o640, 0o4600])("refuses request mode %o", async (mode) => {
    await writeOwned(requestPath(), { path: srv() }, { mode });
    expect(await allow()).toBe(EXIT_CODES.requestRefused);
  });

  it("refuses a config.env the service user owns or may write", async () => {
    await mkdir(join(srv(), "media"));
    await writeOwned(requestPath(), { path: join(srv(), "media") });
    await chown(dependencies.configFile, SERVICE.uid, SERVICE.gid);
    expect(await allow()).toBe(EXIT_CODES.configRefused);
    await chown(dependencies.configFile, 0, SERVICE.gid);
    await chmod(dependencies.configFile, 0o660);
    expect(await allow()).toBe(EXIT_CODES.configRefused);
    expect(await dropInExists()).toBe(false);
  });

  it("refuses a symlink in a prefix that points at /etc, and changes nothing there", async () => {
    await symlink("/etc", join(srv(), "etc"));
    await writeOwned(requestPath(), { path: join(srv(), "etc") });
    expect(await allow()).toBe(EXIT_CODES.systemFolder);
    expect(await dropInExists()).toBe(false);
    expect(programs).toEqual([]);
  });

  it("refuses a symlink in a prefix that points outside it", async () => {
    await symlink(join(root, "outside"), join(srv(), "escape"));
    await writeOwned(requestPath(), { path: join(srv(), "escape") });
    expect(await allow()).toBe(EXIT_CODES.outsideAllowedFolders);
  });
});
