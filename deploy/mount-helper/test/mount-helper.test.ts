import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the helper is one file, not a module with an index.ts.
import { EXIT_CODES, lookUpAccount, runHelper, type ExecFile, type HelperDependencies } from "../src/mount-helper.mts";

const ID = "0b6e7a2c-4f1d-4c3e-9a8b-5d6c7e8f9a0b";
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

const VALID = {
  host: "nas.local",
  share: "media",
  subfolder: "",
  username: "alice",
  password: "s3cret, with = and spaces",
  domain: "",
  vers: "3.1.1",
  seal: true,
};

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly credentials: string | undefined;
}

let root: string;
let calls: Call[];
let errors: string[];
let failWith: unknown;
let mountInfo: string;
let dependencies: HelperDependencies;

const requestDir = (): string => join(root, "requests");
const credentialsDir = (): string => join(root, "credentials");
const mountRoot = (): string => join(root, "mounts");
const mountPoint = (): string => join(mountRoot(), ID);
const credentialsOption = (): string => `credentials=${join(credentialsDir(), `${ID}.cred`)}`;

const fakeExecFile: ExecFile = async (file, args) => {
  // What the credentials file holds while mount.cifs would read it.
  const option = args[3]?.split(",").find((entry) => entry.startsWith("credentials="));
  const credentials = option === undefined ? undefined : await readFile(option.slice("credentials=".length), "utf8");
  calls.push({ file, args, credentials });
  if (failWith !== undefined) throw failWith;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mount-helper-"));
  await mkdir(requestDir(), { mode: 0o700 });
  await mkdir(mountRoot());
  await chmod(mountRoot(), 0o755);
  calls = [];
  errors = [];
  failWith = undefined;
  mountInfo = "";
  dependencies = {
    requestDir: requestDir(),
    credentialsDir: credentialsDir(),
    mountRoot: mountRoot(),
    rootUid: uid,
    serviceUser: async () => ({ uid, gid }),
    mountInfo: async () => mountInfo,
    execFile: fakeExecFile,
    writeError: (line) => errors.push(line),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRequest(content: unknown, id = ID): Promise<string> {
  const path = join(requestDir(), `${id}.json`);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function mountWith(fields: Record<string, unknown>): Promise<number> {
  await writeRequest({ ...VALID, ...fields });
  return runHelper(["mount", ID], dependencies);
}

function options(): string[] {
  return calls[0]?.args[3]?.split(",") ?? [];
}

describe("the id", () => {
  it.each([
    [[]],
    [["mount"]],
    [["mount", ""]],
    [["mount", "../x"]],
    [["mount", "not-a-uuid"]],
    [["mount", `${ID}/..`]],
    [["mount", ` ${ID}`]],
    [["mount", ID, "extra"]],
    [["remount", ID]],
  ])("refuses %j with the usage code", async (argv) => {
    expect(await runHelper(argv, dependencies)).toBe(EXIT_CODES.usage);
    expect(calls).toEqual([]);
  });

  it("accepts an uppercase UUID and uses it in lowercase", async () => {
    await writeRequest(VALID);
    expect(await runHelper(["mount", ID.toUpperCase()], dependencies)).toBe(EXIT_CODES.ok);
    expect(calls[0]?.args[1]).toBe(join(mountRoot(), ID));
  });
});

describe("the request file", () => {
  it("answers request-missing when there is none", async () => {
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestMissing);
  });

  it("refuses a symlink, and leaves its target", async () => {
    const target = join(root, "elsewhere.json");
    await writeFile(target, JSON.stringify(VALID), { mode: 0o600 });
    await symlink(target, join(requestDir(), `${ID}.json`));
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestRefused);
    expect(await exists(target)).toBe(true);
    expect(await exists(join(requestDir(), `${ID}.json`))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a request directory swapped for a symlink, and neither reads nor deletes what it points at", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    const target = join(elsewhere, `${ID}.json`);
    await writeFile(target, JSON.stringify(VALID), { mode: 0o600 });
    await rm(requestDir(), { recursive: true });
    await symlink(elsewhere, requestDir());
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestRefused);
    expect(await runHelper(["unmount", ID], dependencies)).toBe(EXIT_CODES.ok);
    expect(await exists(target)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a mode other than 0600", async () => {
    const path = await writeRequest(VALID);
    await chmod(path, 0o640);
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it("refuses a file owned by someone other than the service user", async () => {
    await writeRequest(VALID);
    dependencies = { ...dependencies, serviceUser: async () => ({ uid: uid + 1, gid }) };
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it("refuses 8 KiB or more and accepts just under", async () => {
    const json = JSON.stringify(VALID);
    await writeRequest(json.padEnd(8192, " "));
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestRefused);
    await writeRequest(json.padEnd(8191, " "));
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.ok);
  });

  it("refuses a directory", async () => {
    await mkdir(join(requestDir(), `${ID}.json`), { mode: 0o600 });
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it.each([["not json"], ["[]"], ["null"], ['"text"']])("refuses %j as invalid", async (content) => {
    await writeRequest(content);
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestInvalid);
  });

  it("refuses bytes that aren't UTF-8", async () => {
    const path = join(requestDir(), `${ID}.json`);
    await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]), { mode: 0o600 });
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestInvalid);
  });
});

describe("validation", () => {
  it.each([
    ["host", "nas.local,uid=0"],
    ["host", "nas local"],
    ["host", "nas/share"],
    ["host", "[::1]"],
    ["host", "fe80::1%eth0"],
    ["host", ""],
    ["host", "a".repeat(254)],
    ["share", "media,uid=0"],
    ["share", "media=x"],
    ["share", "../etc"],
    ["share", ".."],
    ["share", "."],
    ["share", "a/b"],
    ["share", "a\\b"],
    ["share", "line\nbreak"],
    ["share", ""],
    ["share", "a".repeat(81)],
    ["subfolder", "../etc"],
    ["subfolder", "a/../b"],
    ["subfolder", "a/./b"],
    ["subfolder", "/a"],
    ["subfolder", "a/"],
    ["subfolder", "a//b"],
    ["subfolder", "a,uid=0"],
    ["subfolder", "a\tb"],
    ["subfolder", "a/".repeat(512) + "a"],
    ["username", "alice,uid=0"],
    ["username", "user=root"],
    ["username", "alice\npassword=x"],
    ["username", "alice\r"],
    ["username", "alice\u0000"],
    ["username", ""],
    ["username", "a".repeat(105)],
    ["domain", "WORK,uid=0"],
    ["domain", "user=root"],
    ["domain", "WORK\nusername=root"],
    ["password", "secret\nusername=root"],
    ["password", "secret\r"],
    ["password", "secret\u0000"],
    ["password", ""],
    ["password", "a".repeat(257)],
    ["vers", "1.0"],
    ["vers", "3.02"],
    ["vers", "3.1.1,uid=0"],
    ["vers", 3],
    ["seal", "true"],
    ["seal", 1],
    ["host", 42],
    ["share", null],
    ["subfolder", []],
    ["username", { name: "x" }],
  ])("refuses %s %j", async (key, value) => {
    expect(await mountWith({ [key]: value })).toBe(EXIT_CODES.requestInvalid);
    expect(calls).toEqual([]);
  });

  it("refuses unknown and missing keys", async () => {
    expect(await mountWith({ options: "uid=0" })).toBe(EXIT_CODES.requestInvalid);
    const { seal: _seal, ...withoutSeal } = VALID;
    await writeRequest(withoutSeal);
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestInvalid);
    await writeRequest(`{"__proto__":{"x":1},${JSON.stringify(VALID).slice(1)}`);
    expect(await runHelper(["mount", ID], dependencies)).toBe(EXIT_CODES.requestInvalid);
  });

  it.each([
    ["host", "192.168.1.10"],
    ["host", "fd00::10"],
    ["share", "My Files (2024)"],
    ["subfolder", "Photos/2024 Summer"],
    ["username", "Alice Smith"],
    ["domain", "WORKGROUP"],
    ["password", "p@ss word,=;\"'\\"],
  ])("accepts %s %j", async (key, value) => {
    expect(await mountWith({ [key]: value })).toBe(EXIT_CODES.ok);
  });

  it("never writes a field's value to stderr", async () => {
    await mountWith({ password: "hunter2\nusername=root" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("hunter2");
  });
});

describe("mount.cifs", () => {
  const FIXED = [
    "forceuid",
    "forcegid",
    "file_mode=0640",
    "dir_mode=0750",
    "nosuid",
    "nodev",
    "noexec",
    "nounix",
    "soft",
    "echo_interval=30",
    "iocharset=utf8",
  ];

  it("gets an argument array with exactly the helper's options", async () => {
    expect(await mountWith({})).toBe(EXIT_CODES.ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("mount.cifs");
    expect(calls[0]?.args).toEqual(["//nas.local/media", join(mountRoot(), ID), "-o", expect.any(String)]);
    expect(options()).toEqual(["vers=3.1.1", "sign", "seal", credentialsOption(), `uid=${uid}`, `gid=${gid}`, ...FIXED]);
  });

  it.each([
    ["3.1.1", true, true],
    ["3.1.1", false, false],
    ["3.0", true, true],
    ["3.0", false, false],
    ["2.1", true, false],
    ["2.1", false, false],
  ])("vers %s with seal %s %s seal", async (vers, seal, sealed) => {
    expect(await mountWith({ vers, seal })).toBe(EXIT_CODES.ok);
    expect(options()).toEqual([
      `vers=${vers}`,
      "sign",
      ...(sealed ? ["seal"] : []),
      credentialsOption(),
      `uid=${uid}`,
      `gid=${gid}`,
      ...FIXED,
    ]);
  });

  it("adds the subfolder to the UNC", async () => {
    await mountWith({ subfolder: "Photos/2024" });
    expect(calls[0]?.args[0]).toBe("//nas.local/media/Photos/2024");
  });

  it("brackets an IPv6 host and passes it as ip=", async () => {
    await mountWith({ host: "fd00::10" });
    expect(calls[0]?.args[0]).toBe("//[fd00::10]/media");
    expect(options().at(-1)).toBe("ip=fd00::10");
  });

  it("writes the credentials file root-only while mounting", async () => {
    await mountWith({ domain: "WORK" });
    expect(calls[0]?.credentials).toBe(`username=alice\npassword=${VALID.password}\ndomain=WORK\n`);
    expect((await stat(credentialsDir())).mode & 0o7777).toBe(0o700);
  });

  it("leaves out the domain line when there is no domain", async () => {
    await mountWith({});
    expect(calls[0]?.credentials).toBe(`username=alice\npassword=${VALID.password}\n`);
  });

  it("leaves neither the request nor the credentials file after a mount, and keeps the mount point", async () => {
    expect(await mountWith({})).toBe(EXIT_CODES.ok);
    expect(await readdir(requestDir())).toEqual([]);
    expect(await readdir(credentialsDir())).toEqual([]);
    expect(await exists(join(mountRoot(), ID))).toBe(true);
  });

  it("leaves neither file nor the mount point after a failed mount", async () => {
    failWith = Object.assign(new Error("Command failed"), { code: 32, stderr: "mount error(13): Permission denied\n" });
    expect(await mountWith({})).toBe(EXIT_CODES.auth);
    expect(await readdir(requestDir())).toEqual([]);
    expect(await readdir(credentialsDir())).toEqual([]);
    expect(await readdir(mountRoot())).toEqual([]);
  });

  it("leaves the request file nowhere after a validation failure", async () => {
    expect(await mountWith({ host: "a,b" })).toBe(EXIT_CODES.requestInvalid);
    expect(await readdir(requestDir())).toEqual([]);
    expect(await exists(credentialsDir())).toBe(false);
  });

  it("replaces a stale credentials file", async () => {
    await mkdir(credentialsDir(), { mode: 0o700 });
    await writeFile(join(credentialsDir(), `${ID}.cred`), "stale");
    await mountWith({});
    expect(calls[0]?.credentials).toContain("username=alice");
    expect(await readdir(credentialsDir())).toEqual([]);
  });

  it.each([
    [13, EXIT_CODES.auth],
    [1, EXIT_CODES.auth],
    [126, EXIT_CODES.auth],
    [127, EXIT_CODES.auth],
    [128, EXIT_CODES.auth],
    [129, EXIT_CODES.auth],
    [101, EXIT_CODES.unreachable],
    [104, EXIT_CODES.unreachable],
    [110, EXIT_CODES.unreachable],
    [111, EXIT_CODES.unreachable],
    [112, EXIT_CODES.unreachable],
    [113, EXIT_CODES.unreachable],
    [2, EXIT_CODES.noShare],
    [6, EXIT_CODES.noShare],
    [20, EXIT_CODES.noShare],
    [95, EXIT_CODES.notSupported],
    [93, EXIT_CODES.notSupported],
    [22, EXIT_CODES.mountFailed],
  ])("maps mount error(%i) to exit %i", async (errno, exitCode) => {
    failWith = Object.assign(new Error("Command failed"), {
      code: 32,
      stderr: `mount error(${errno}): Something\nRefer to the mount.cifs(8) manual page\n`,
    });
    expect(await mountWith({})).toBe(exitCode);
  });

  it.each([
    [{ code: 1, stderr: "mount error: could not resolve address for nas.local: Unknown error\n" }, EXIT_CODES.unreachable],
    [{ killed: true, signal: "SIGTERM", stderr: "" }, EXIT_CODES.unreachable],
    [{ code: "ENOENT", stderr: "" }, EXIT_CODES.mountFailed],
    [{ code: 32, stderr: "something else\n" }, EXIT_CODES.mountFailed],
  ])("maps %j", async (fields, exitCode) => {
    failWith = Object.assign(new Error("Command failed"), fields);
    expect(await mountWith({})).toBe(exitCode);
  });

  it("refuses a symlinked credentials directory", async () => {
    const target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, credentialsDir());
    expect(await mountWith({})).toBe(EXIT_CODES.internal);
    expect(await readdir(target)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a credentials directory with another mode", async () => {
    await mkdir(credentialsDir());
    await chmod(credentialsDir(), 0o755);
    expect(await mountWith({})).toBe(EXIT_CODES.internal);
  });

  it("refuses a symlinked mount root", async () => {
    const target = join(root, "target");
    await mkdir(target);
    await chmod(target, 0o755);
    dependencies = { ...dependencies, mountRoot: join(root, "link") };
    await symlink(target, dependencies.mountRoot);
    expect(await mountWith({})).toBe(EXIT_CODES.internal);
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses a mount root others can write to", async () => {
    await chmod(mountRoot(), 0o777);
    expect(await mountWith({})).toBe(EXIT_CODES.internal);
  });
});

describe("unmount", () => {
  it("unmounts a mount point and removes it", async () => {
    await mkdir(mountPoint());
    mountInfo = `36 25 0:32 / /other rw - tmpfs tmpfs rw\n97 36 0:51 / ${mountPoint()} rw,nosuid - cifs //nas.local/media rw\n`;
    expect(await runHelper(["unmount", ID], dependencies)).toBe(EXIT_CODES.ok);
    expect(calls.map(({ file, args }) => [file, args])).toEqual([["umount", [mountPoint()]]]);
    expect(await exists(mountPoint())).toBe(false);
  });

  it("only removes a mount point that isn't mounted", async () => {
    await mkdir(mountPoint());
    mountInfo = `97 36 0:51 / ${mountPoint()}-other rw - cifs //x/y rw\n`;
    expect(await runHelper(["unmount", ID], dependencies)).toBe(EXIT_CODES.ok);
    expect(calls).toEqual([]);
    expect(await exists(mountPoint())).toBe(false);
  });

  it("succeeds when there is nothing to unmount, and deletes leftovers", async () => {
    await writeRequest(VALID);
    await mkdir(credentialsDir(), { mode: 0o700 });
    await writeFile(join(credentialsDir(), `${ID}.cred`), "x");
    expect(await runHelper(["unmount", ID], dependencies)).toBe(EXIT_CODES.ok);
    expect(await readdir(requestDir())).toEqual([]);
    expect(await readdir(credentialsDir())).toEqual([]);
  });

  it("answers unmount-failed when umount fails", async () => {
    await mkdir(mountPoint());
    mountInfo = `97 36 0:51 / ${mountPoint()} rw - cifs //x/y rw\n`;
    failWith = Object.assign(new Error("Command failed"), { code: 32, stderr: "umount: target is busy.\n" });
    expect(await runHelper(["unmount", ID], dependencies)).toBe(EXIT_CODES.unmountFailed);
    expect(await exists(mountPoint())).toBe(true);
  });

  it("refuses a non-UUID id", async () => {
    expect(await runHelper(["unmount", "../../etc"], dependencies)).toBe(EXIT_CODES.usage);
  });
});

describe("lookUpAccount", () => {
  const passwd =
    "root:x:0:0:root:/root:/bin/bash\nnot-unreachable-x:x:5:5::/:/usr/sbin/nologin\nnot-unreachable:x:998:997::/var/lib/not-unreachable:/usr/sbin/nologin\n";

  it("finds the service user's uid and gid", () => {
    expect(lookUpAccount(passwd, "not-unreachable")).toEqual({ uid: 998, gid: 997 });
  });

  it("throws when the user is missing", () => {
    expect(() => lookUpAccount("root:x:0:0::/:/bin/sh\n", "not-unreachable")).toThrow("no user");
  });
});

describe("the exit codes", () => {
  it("are the fixed protocol with the server", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      internal: 1,
      usage: 2,
      requestMissing: 3,
      requestRefused: 4,
      requestInvalid: 5,
      auth: 10,
      unreachable: 11,
      noShare: 12,
      notSupported: 13,
      mountFailed: 14,
      unmountFailed: 15,
    });
  });
});
