import { execFile } from "node:child_process";
import { chmod, chown, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the helper is one file, not a module with an index.ts.
import { EXIT_CODES, runHelper, type ExecFile, type HelperDependencies } from "../src/mount-helper.mts";

// These tests check the helper against the real file system as root, which is how it runs. Run
// elsewhere they would prove nothing, so they fail instead of skipping.
if (process.getuid?.() !== 0) throw new Error("The hostile-request tests must run as root: sudo pnpm test:helper-root");

const ID = "0b6e7a2c-4f1d-4c3e-9a8b-5d6c7e8f9a0b";
// The service user: anyone but root (nobody).
const SERVICE = { uid: 65534, gid: 65534 };
const GENUINE = {
  host: "genuine.local",
  share: "media",
  subfolder: "",
  username: "alice",
  password: "secret",
  domain: "",
  vers: "3.1.1",
  seal: true,
};
const HOSTILE = { ...GENUINE, host: "hostile.local" };

let root: string;
let hosts: string[];
let dependencies: HelperDependencies;

const requestPath = (): string => join(root, "requests", `${ID}.json`);

const fakeExecFile: ExecFile = async (_file, args) => {
  hosts.push(args[0] ?? "");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mount-helper-root-"));
  await chmod(root, 0o755);
  await mkdir(join(root, "requests"), { mode: 0o700 });
  await chown(join(root, "requests"), SERVICE.uid, SERVICE.gid);
  await mkdir(join(root, "mounts"));
  await chmod(join(root, "mounts"), 0o755);
  hosts = [];
  dependencies = {
    requestDir: join(root, "requests"),
    credentialsDir: join(root, "credentials"),
    mountRoot: join(root, "mounts"),
    rootUid: 0,
    serviceUser: async () => SERVICE,
    mountInfo: async () => "",
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

async function snapshot(path: string): Promise<{ content: string; mtimeMs: number; mode: number; uid: number }> {
  const stats = await stat(path);
  return { content: await readFile(path, "utf8"), mtimeMs: stats.mtimeMs, mode: stats.mode, uid: stats.uid };
}

const mount = (): Promise<number> => runHelper(["mount", ID], dependencies);

describe("the helper as root", () => {
  it("mounts a genuine request", async () => {
    await writeOwned(requestPath(), GENUINE);
    expect(await mount()).toBe(EXIT_CODES.ok);
    expect(hosts).toEqual(["//genuine.local/media"]);
    expect(await readdir(join(root, "requests"))).toEqual([]);
    expect(await readdir(join(root, "credentials"))).toEqual([]);
  });

  it("refuses a symlink to a valid request of the service user, and leaves the target", async () => {
    const target = join(root, "target.json");
    await writeOwned(target, HOSTILE);
    const before = await snapshot(target);
    await symlink(target, requestPath());
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
    expect(hosts).toEqual([]);
    expect(await snapshot(target)).toEqual(before);
    expect(await lstat(requestPath()).catch(() => undefined)).toBeUndefined();
  });

  it("refuses a symlink to a root-only file and leaves it", async () => {
    const shadow = await stat("/etc/shadow").then(
      () => "/etc/shadow",
      async () => {
        const standIn = join(root, "shadow");
        await writeOwned(standIn, "root:$6$hash:19000:0:99999:7:::\n", { uid: 0 });
        return standIn;
      },
    );
    const before = await snapshot(shadow);
    await symlink(shadow, requestPath());
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
    expect(await snapshot(shadow)).toEqual(before);
  });

  it("refuses a FIFO without waiting for a writer", async () => {
    await promisify(execFile)("mkfifo", ["-m", "0600", requestPath()]);
    await chown(requestPath(), SERVICE.uid, SERVICE.gid);
    const started = Date.now();
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 5000);

  it("refuses a request owned by root", async () => {
    await writeOwned(requestPath(), GENUINE, { uid: 0 });
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
    expect(hosts).toEqual([]);
  });

  it("refuses a request owned by another user", async () => {
    await writeOwned(requestPath(), GENUINE, { uid: 65533 });
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
  });

  it.each([0o644, 0o640, 0o400, 0o4600, 0o700])("refuses mode %o", async (mode) => {
    await writeOwned(requestPath(), GENUINE, { mode });
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
  });

  it.each([8192, 65536])("refuses a request of %i bytes", async (size) => {
    await writeOwned(requestPath(), JSON.stringify(GENUINE).padEnd(size, " "));
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
  });

  it("refuses a hard link to a root-owned file", async () => {
    const target = join(root, "root-owned.json");
    await writeOwned(target, HOSTILE, { uid: 0 });
    await link(target, requestPath());
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(HOSTILE));
  });

  it("never reads a symlink swapped in while it runs", async () => {
    const target = join(root, "hostile.json");
    await writeOwned(target, HOSTILE);
    const before = await snapshot(target);
    const staged = join(root, "requests", "staged");
    const swapping = { running: true };
    // Swaps the request path between a genuine file and a symlink to the hostile one, as fast as it can.
    const swapper = (async () => {
      for (let round = 0; swapping.running; round += 1) {
        if (round % 2 === 0) {
          await writeOwned(staged, GENUINE);
        } else {
          await rm(staged, { force: true });
          await symlink(target, staged);
        }
        await rename(staged, requestPath());
      }
    })();
    const results: number[] = [];
    for (let run = 0; run < 300; run += 1) {
      results.push(await mount());
    }
    swapping.running = false;
    await swapper;

    const allowed: readonly number[] = [EXIT_CODES.ok, EXIT_CODES.requestRefused, EXIT_CODES.requestMissing];
    expect(results.filter((result) => !allowed.includes(result))).toEqual([]);
    expect(hosts).not.toContain("//hostile.local/media");
    expect(hosts.length).toBe(results.filter((result) => result === EXIT_CODES.ok).length);
    expect(await snapshot(target)).toEqual(before);
    expect(await readdir(join(root, "credentials"))).toEqual([]);
  }, 60_000);

  it.each([
    ["host", "genuine.local,uid=0"],
    ["host", "genuine.local -o uid=0"],
    ["share", "media,uid=0,gid=0"],
    ["share", "media,suid"],
    ["share", ".."],
    ["share", "../etc"],
    ["subfolder", "../../etc"],
    ["subfolder", "a,exec"],
    ["username", "alice,uid=0"],
    ["username", "alice\nuid=0"],
    ["domain", "WORK,setuids"],
    ["password", "secret\nusername=root"],
    ["vers", "3.1.1,uid=0"],
    ["seal", "true,noperm"],
  ])("refuses an injected %s %j without running mount.cifs", async (field, value) => {
    await writeOwned(requestPath(), { ...GENUINE, [field]: value });
    expect(await mount()).toBe(EXIT_CODES.requestInvalid);
    expect(hosts).toEqual([]);
    expect(await readdir(join(root, "requests"))).toEqual([]);
    expect(await readdir(join(root, "mounts"))).toEqual([]);
  });

  it("refuses an option smuggled in as an extra field", async () => {
    await writeOwned(requestPath(), { ...GENUINE, options: "uid=0" });
    expect(await mount()).toBe(EXIT_CODES.requestInvalid);
    expect(hosts).toEqual([]);
  });

  it("refuses bytes that aren't UTF-8", async () => {
    await writeFile(requestPath(), Buffer.concat([Buffer.from('{"host":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]));
    await chown(requestPath(), SERVICE.uid, SERVICE.gid);
    await chmod(requestPath(), 0o600);
    expect(await mount()).toBe(EXIT_CODES.requestInvalid);
    expect(hosts).toEqual([]);
  });

  it("refuses a request directory swapped for a symlink, and neither reads nor deletes what it points at", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await chown(elsewhere, SERVICE.uid, SERVICE.gid);
    await writeOwned(join(elsewhere, `${ID}.json`), HOSTILE);
    const before = await snapshot(join(elsewhere, `${ID}.json`));
    await rm(join(root, "requests"), { recursive: true });
    await symlink(elsewhere, join(root, "requests"));
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
    expect(hosts).toEqual([]);
    expect(await snapshot(join(elsewhere, `${ID}.json`))).toEqual(before);
  });

  it("refuses a request directory that is a symlink to a root-only folder", async () => {
    await rm(join(root, "requests"), { recursive: true });
    await symlink("/root", join(root, "requests"));
    expect(await mount()).toBe(EXIT_CODES.requestRefused);
    expect(hosts).toEqual([]);
  });

  it("refuses a symlinked credentials directory", async () => {
    const target = join(root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, dependencies.credentialsDir);
    await writeOwned(requestPath(), GENUINE);
    expect(await mount()).toBe(EXIT_CODES.internal);
    expect(await readdir(target)).toEqual([]);
    expect(hosts).toEqual([]);
  });

  it("refuses a credentials directory the service user owns", async () => {
    await mkdir(dependencies.credentialsDir, { mode: 0o700 });
    await chown(dependencies.credentialsDir, SERVICE.uid, SERVICE.gid);
    await writeOwned(requestPath(), GENUINE);
    expect(await mount()).toBe(EXIT_CODES.internal);
    expect(await readdir(dependencies.credentialsDir)).toEqual([]);
  });

  it("refuses a symlinked mount root", async () => {
    const target = join(root, "elsewhere");
    await mkdir(target);
    await chmod(target, 0o755);
    dependencies = { ...dependencies, mountRoot: join(root, "mounts-link") };
    await symlink(target, dependencies.mountRoot);
    await writeOwned(requestPath(), GENUINE);
    expect(await mount()).toBe(EXIT_CODES.internal);
    expect(await readdir(target)).toEqual([]);
    expect(hosts).toEqual([]);
  });

  it("refuses a mount root the service user owns", async () => {
    await chown(dependencies.mountRoot, SERVICE.uid, SERVICE.gid);
    await writeOwned(requestPath(), GENUINE);
    expect(await mount()).toBe(EXIT_CODES.internal);
    expect(await readdir(dependencies.mountRoot)).toEqual([]);
  });
});
