import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- the shared rules are one file, not a module with an index.ts.
import { overlaps, SYSTEM_FOLDERS } from "../src/folder-access.mts";
// oxlint-disable-next-line no-restricted-imports -- the helper is one file, not a module with an index.ts.
import {
  EXIT_CODES,
  parseEnvironmentFile,
  RESTART_ARGUMENTS,
  runHelper,
  type ExecFile,
  type HelperDependencies,
} from "../src/folder-helper.mts";

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

let root: string;
let calls: Call[];
let errors: string[];
let failWith: unknown;
let dependencies: HelperDependencies;

const requestDir = (): string => join(root, "requests");
const requestPath = (): string => join(requestDir(), "allow-folder.json");
const configFile = (): string => join(root, "config.env");
const dropInDir = (): string => join(root, "not-unreachable.service.d");
const dropIn = (): string => join(dropInDir(), "resources.conf");
const srv = (): string => join(root, "srv");
const mnt = (): string => join(root, "mnt");
const dataDir = (): string => join(srv(), "data");
const releaseDir = (): string => join(srv(), "release");
const mountRoot = (): string => join(srv(), "mounts");
// A system folder stand-in: the real ones can't be made in a temp dir.
const systemFolder = (): string => join(root, "etc");

const fakeExecFile: ExecFile = async (file, args, options) => {
  calls.push({ file, args, env: options.env });
  if (failWith !== undefined) throw failWith;
};

function config(lines: readonly string[] = []): string {
  return [
    "# NotUnreachable bootstrap config",
    "PUBLIC_ORIGIN=https://files.example.com",
    "ALLOW_FOLDERS_FROM_UI=true",
    `ALLOWED_FOLDER_PREFIXES=${srv()},${mnt()}`,
    `DATA_DIR=${dataDir()}`,
    ...lines,
    "",
  ].join("\n");
}

async function writeConfig(content: string, mode = 0o640): Promise<void> {
  await writeFile(configFile(), content);
  await chmod(configFile(), mode);
}

async function writeRequest(content: unknown): Promise<void> {
  await writeFile(requestPath(), typeof content === "string" || content instanceof Buffer ? content : JSON.stringify(content));
  await chmod(requestPath(), 0o600);
}

async function allowPath(path: string): Promise<number> {
  await writeRequest({ path });
  return runHelper(["allow"], dependencies);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "folder-helper-")));
  await mkdir(requestDir(), { mode: 0o700 });
  for (const folder of [srv(), mnt(), dataDir(), releaseDir(), mountRoot(), systemFolder(), join(root, "srv2"), join(root, "outside")]) {
    await mkdir(folder, { recursive: true });
  }
  await mkdir(dropInDir(), { mode: 0o755 });
  await writeConfig(config());
  calls = [];
  errors = [];
  failWith = undefined;
  dependencies = {
    requestDir: requestDir(),
    configFile: configFile(),
    dropInDir: dropInDir(),
    releaseDir: releaseDir(),
    mountRoot: mountRoot(),
    rootUid: uid,
    // The temp dir lies in /tmp, a system folder; the stand-in takes its place.
    systemFolders: [...SYSTEM_FOLDERS.filter((folder) => !overlaps(root, folder)), systemFolder()],
    serviceUser: async () => ({ uid, gid }),
    execFile: fakeExecFile,
    writeError: (line) => errors.push(line),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the usage", () => {
  it.each([[[]], [["allow", "/srv/media"]], [["deny"]], [["ALLOW"]]])("refuses %j", async (argv) => {
    await writeRequest({ path: join(srv(), "data") });
    expect(await runHelper(argv, dependencies)).toBe(EXIT_CODES.usage);
    expect(calls).toEqual([]);
  });
});

describe("an allowed folder", () => {
  it("is added to the drop-in by its real path, then systemd reloads and the restart is scheduled", async () => {
    const media = join(srv(), "media");
    await mkdir(media);
    expect(await allowPath(media)).toBe(EXIT_CODES.ok);
    expect(await readFile(dropIn(), "utf8")).toContain(`\nReadWritePaths=${media}\n`);
    const path = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
    expect(calls).toEqual([
      { file: "systemctl", args: ["daemon-reload"], env: path },
      {
        file: "systemd-run",
        args: [
          "--quiet",
          "--collect",
          "--no-block",
          "--on-active=3s",
          "--description=not-unreachable: restart after allowing a folder",
          "/usr/bin/systemctl",
          "restart",
          "not-unreachable.service",
        ],
        env: path,
      },
    ]);
    expect(RESTART_ARGUMENTS).toEqual(calls[1]?.args);
    expect(errors).toEqual([]);
  });

  it("is followed through a symlink that stays inside the prefixes, and listed by its real path", async () => {
    const target = join(mnt(), "photos");
    await mkdir(target);
    await symlink(target, join(srv(), "photos-link"));
    expect(await allowPath(join(srv(), "photos-link"))).toBe(EXIT_CODES.ok);
    const content = await readFile(dropIn(), "utf8");
    expect(content).toContain(`ReadWritePaths=${target}\n`);
    expect(content).not.toContain("photos-link");
  });

  it("reloads and restarts even when the folder is listed already", async () => {
    await mkdir(join(srv(), "media"));
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.ok);
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.ok);
    expect(calls.map((call) => call.file)).toEqual(["systemctl", "systemd-run", "systemctl", "systemd-run"]);
  });

  it("keeps the folders listed before", async () => {
    await mkdir(join(srv(), "a"));
    await mkdir(join(mnt(), "b"));
    expect(await allowPath(join(srv(), "a"))).toBe(EXIT_CODES.ok);
    expect(await allowPath(join(mnt(), "b"))).toBe(EXIT_CODES.ok);
    const content = await readFile(dropIn(), "utf8");
    expect(content).toContain(`ReadWritePaths=${join(srv(), "a")}\n`);
    expect(content).toContain(`ReadWritePaths=${join(mnt(), "b")}\n`);
  });

  it("is a prefix itself", async () => {
    await writeConfig(config([`ALLOWED_FOLDER_PREFIXES=${mnt()}`]));
    expect(await allowPath(mnt())).toBe(EXIT_CODES.ok);
  });

  it("answers systemd-failed when systemctl or systemd-run fails", async () => {
    await mkdir(join(srv(), "media"));
    failWith = Object.assign(new Error("exit 1"), { code: 1 });
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.systemdFailed);
    expect(errors).toEqual(["allow: systemctl daemon-reload failed"]);
  });
});

describe("the switch", () => {
  it.each([
    ["off", "ALLOW_FOLDERS_FROM_UI=false"],
    ["True", "ALLOW_FOLDERS_FROM_UI=True"],
    ["1", "ALLOW_FOLDERS_FROM_UI=1"],
    ["yes", "ALLOW_FOLDERS_FROM_UI=yes"],
    ["empty", "ALLOW_FOLDERS_FROM_UI="],
    ["commented out", "#ALLOW_FOLDERS_FROM_UI=true"],
  ])("is off when %s, and nothing is read or changed", async (_name, line) => {
    await writeConfig(config().replace("ALLOW_FOLDERS_FROM_UI=true", line));
    await mkdir(join(srv(), "media"));
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.switchOff);
    expect(await exists(dropIn())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("is off when config.env doesn't mention it", async () => {
    await writeConfig("PUBLIC_ORIGIN=https://files.example.com\n");
    expect(await allowPath(srv())).toBe(EXIT_CODES.switchOff);
  });

  it("is off even before the request is read", async () => {
    await writeConfig(config().replace("ALLOW_FOLDERS_FROM_UI=true", "ALLOW_FOLDERS_FROM_UI=false"));
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.switchOff);
  });

  it.each(['"true"', "'true'", " true "])("is on for %j", async (value) => {
    await writeConfig(config().replace("ALLOW_FOLDERS_FROM_UI=true", `ALLOW_FOLDERS_FROM_UI=${value}`));
    await mkdir(join(srv(), "media"));
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.ok);
  });
});

describe("config.env", () => {
  it("is refused when it isn't root's", async () => {
    dependencies = { ...dependencies, rootUid: uid + 1 };
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
    expect(calls).toEqual([]);
  });

  it.each([0o660, 0o646, 0o666, 0o620])("is refused with mode %o", async (mode) => {
    await chmod(configFile(), mode);
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
  });

  it("is refused when it is a symlink", async () => {
    const real = join(root, "real.env");
    await writeFile(real, config());
    await rm(configFile());
    await symlink(real, configFile());
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
  });

  it("is refused when missing, a folder, 64 KiB or more, or not UTF-8", async () => {
    await rm(configFile());
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
    await mkdir(configFile());
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
    await rm(configFile(), { recursive: true });
    await writeConfig(config().padEnd(65_536, "#"));
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
    await writeFile(configFile(), Buffer.concat([Buffer.from(config()), Buffer.from([0xff])]));
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
  });

  it.each(["/", "/etc", "/usr/local", "/srv/../etc", "srv", "/srv/"])("refuses every folder when a prefix is %j", async (prefix) => {
    await writeConfig(config([`ALLOWED_FOLDER_PREFIXES=${srv()},${prefix}`]));
    await mkdir(join(srv(), "media"));
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.configRefused);
    expect(errors[0]).toMatch(/^allow: ALLOWED_FOLDER_PREFIXES: /u);
    expect(calls).toEqual([]);
  });

  it("refuses every folder when a prefix is or holds the system folder stand-in", async () => {
    await writeConfig(config([`ALLOWED_FOLDER_PREFIXES=${root}`]));
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
  });

  it("takes /srv and /mnt when ALLOWED_FOLDER_PREFIXES is missing or empty", async () => {
    await mkdir(join(srv(), "media"));
    for (const content of [config().replace(/^ALLOWED_FOLDER_PREFIXES=.*$/mu, ""), config([`ALLOWED_FOLDER_PREFIXES= , `])]) {
      await writeConfig(content);
      expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.outsideAllowedFolders);
      expect(errors.at(-1)).toContain("(/srv,/mnt)");
    }
  });

  it("refuses a relative DATA_DIR", async () => {
    await writeConfig(config(["DATA_DIR=var/lib/not-unreachable"]));
    expect(await allowPath(srv())).toBe(EXIT_CODES.configRefused);
  });
});

describe("parseEnvironmentFile", () => {
  it("reads systemd's KEY=VALUE subset", () => {
    const values = parseEnvironmentFile(
      [
        "# comment",
        "; comment",
        "",
        "  A = one  ",
        'B="two words"',
        "C='three'",
        "D=\"unmatched'",
        "E=a=b",
        "no equals sign",
        "=no key",
        "A=again",
      ].join("\n"),
    );
    expect(Object.fromEntries(values)).toEqual({ A: "again", B: "two words", C: "three", D: "\"unmatched'", E: "a=b" });
  });
});

describe("the request file", () => {
  it("answers request-missing when there is none, or no request folder", async () => {
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestMissing);
    await rm(requestDir(), { recursive: true });
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestMissing);
  });

  it("is left where it is, for the server to delete", async () => {
    await mkdir(join(srv(), "media"));
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.ok);
    expect(await exists(requestPath())).toBe(true);
  });

  it("refuses a symlink, and leaves its target", async () => {
    const target = join(root, "elsewhere.json");
    await writeFile(target, JSON.stringify({ path: srv() }), { mode: 0o600 });
    await symlink(target, requestPath());
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestRefused);
    expect(await exists(target)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a request folder swapped for a symlink", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await writeFile(join(elsewhere, "allow-folder.json"), JSON.stringify({ path: srv() }), { mode: 0o600 });
    await rm(requestDir(), { recursive: true });
    await symlink(elsewhere, requestDir());
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it.each([0o640, 0o644, 0o400, 0o700])("refuses mode %o", async (mode) => {
    await writeRequest({ path: srv() });
    await chmod(requestPath(), mode);
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it("refuses a file owned by someone other than the service user", async () => {
    await writeRequest({ path: srv() });
    dependencies = { ...dependencies, serviceUser: async () => ({ uid: uid + 1, gid }) };
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it("refuses 8 KiB or more", async () => {
    await writeRequest(JSON.stringify({ path: srv() }).padEnd(8192, " "));
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it("refuses a FIFO without waiting for a writer", async () => {
    await promisify(execFile)("mkfifo", ["-m", "0600", requestPath()]);
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestRefused);
  }, 5000);

  it("refuses a folder", async () => {
    await mkdir(requestPath(), { mode: 0o600 });
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestRefused);
  });

  it.each([
    ["not json"],
    ["[]"],
    ["null"],
    ['"/srv"'],
    ["{}"],
    ['{"path":"/srv","extra":1}'],
    ['{"folder":"/srv"}'],
    ['{"path":1}'],
    ['{"path":null}'],
    ['{"path":["/srv"]}'],
    ['{"path":""}'],
    ['{"path":"/srv/a\\u0000b"}'],
    [JSON.stringify({ path: `/${"a".repeat(4096)}` })],
  ])("refuses %j as invalid", async (content) => {
    await writeRequest(content);
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestInvalid);
    expect(calls).toEqual([]);
  });

  it("refuses bytes that aren't UTF-8", async () => {
    await writeRequest(Buffer.concat([Buffer.from('{"path":"/srv/'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]));
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.requestInvalid);
  });

  it("takes a path of 4096 bytes", async () => {
    await writeRequest({ path: `/${"a/".repeat(2047)}a` });
    expect(await runHelper(["allow"], dependencies)).toBe(EXIT_CODES.missing);
  });
});

describe("the folder", () => {
  it.each(["srv/media", "./media", "media", "~/media"])("refuses the relative path %j", async (path) => {
    expect(await allowPath(path)).toBe(EXIT_CODES.notAbsolute);
  });

  it("refuses a path where nothing is", async () => {
    expect(await allowPath(join(srv(), "missing"))).toBe(EXIT_CODES.missing);
    expect(await allowPath(join(srv(), "missing", "deeper"))).toBe(EXIT_CODES.missing);
  });

  it("refuses a path below a file as missing", async () => {
    await writeFile(join(srv(), "file"), "");
    expect(await allowPath(join(srv(), "file", "below"))).toBe(EXIT_CODES.missing);
  });

  it("refuses a file", async () => {
    await writeFile(join(srv(), "file"), "");
    expect(await allowPath(join(srv(), "file"))).toBe(EXIT_CODES.notAFolder);
  });

  it("refuses a symlink to a file", async () => {
    await writeFile(join(root, "outside", "file"), "");
    await symlink(join(root, "outside", "file"), join(srv(), "link"));
    expect(await allowPath(join(srv(), "link"))).toBe(EXIT_CODES.notAFolder);
  });

  it("refuses a folder outside the prefixes", async () => {
    expect(await allowPath(join(root, "outside"))).toBe(EXIT_CODES.outsideAllowedFolders);
    expect(await exists(dropIn())).toBe(false);
    expect(calls).toEqual([]);
  });

  // `/srv2` starts like the prefix `/srv` but is not below it.
  it("refuses a sibling whose name starts like a prefix", async () => {
    expect(await allowPath(join(root, "srv2"))).toBe(EXIT_CODES.outsideAllowedFolders);
  });

  it("refuses a symlink inside a prefix that points outside it", async () => {
    await symlink(join(root, "outside"), join(srv(), "escape"));
    expect(await allowPath(join(srv(), "escape"))).toBe(EXIT_CODES.outsideAllowedFolders);
    expect(errors[0]).toContain(JSON.stringify(join(root, "outside")));
  });

  it("refuses a symlink inside a prefix that points at a system folder", async () => {
    await symlink(systemFolder(), join(srv(), "etc"));
    expect(await allowPath(join(srv(), "etc"))).toBe(EXIT_CODES.systemFolder);
  });

  it("refuses a .. path that climbs out of a prefix", async () => {
    expect(await allowPath(`${srv()}/../outside`)).toBe(EXIT_CODES.outsideAllowedFolders);
  });

  it("refuses a real system folder through a symlink", async () => {
    await symlink("/etc", join(srv(), "real-etc"));
    expect(await allowPath(join(srv(), "real-etc"))).toBe(EXIT_CODES.systemFolder);
  });

  it.each([
    ["the data folder", () => dataDir(), EXIT_CODES.insideDataDirectory],
    ["a folder inside the data folder", () => join(dataDir(), "db"), EXIT_CODES.insideDataDirectory],
    ["a folder holding the data folder", () => srv(), EXIT_CODES.insideDataDirectory],
    ["the release folder", () => releaseDir(), EXIT_CODES.insideReleaseDirectory],
    ["a folder inside the release folder", () => join(releaseDir(), "current"), EXIT_CODES.insideReleaseDirectory],
    ["the mount root", () => mountRoot(), EXIT_CODES.insideMountRoot],
    ["a mount", () => join(mountRoot(), "share"), EXIT_CODES.insideMountRoot],
  ])("refuses %s", async (_name, path, code) => {
    await mkdir(path(), { recursive: true });
    expect(await allowPath(path())).toBe(code);
    expect(calls).toEqual([]);
  });

  it("compares with the service's folders by their real paths", async () => {
    const realData = join(mnt(), "real-data");
    await mkdir(join(realData, "db"), { recursive: true });
    await rm(dataDir(), { recursive: true });
    await symlink(realData, dataDir());
    expect(await allowPath(join(realData, "db"))).toBe(EXIT_CODES.insideDataDirectory);
  });

  it.each([
    ["inside", () => join(srv(), "media", "photos")],
    ["holding", () => join(srv(), "shared")],
  ])("refuses a folder %s one the drop-in lists, which the service could swap for a symlink", async (_name, path) => {
    await mkdir(join(srv(), "media", "photos"), { recursive: true });
    await mkdir(join(srv(), "shared", "music"), { recursive: true });
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.ok);
    expect(await allowPath(join(srv(), "shared", "music"))).toBe(EXIT_CODES.ok);
    const before = await readFile(dropIn(), "utf8");
    calls = [];
    expect(await allowPath(path())).toBe(EXIT_CODES.overlapsAllowedFolder);
    expect(await readFile(dropIn(), "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("compares with a listed folder by its real path too, once it has been swapped for a symlink", async () => {
    await mkdir(join(srv(), "media"));
    await mkdir(join(mnt(), "elsewhere", "inner"), { recursive: true });
    expect(await allowPath(join(srv(), "media"))).toBe(EXIT_CODES.ok);
    await rm(join(srv(), "media"), { recursive: true });
    await symlink(join(mnt(), "elsewhere"), join(srv(), "media"));
    expect(await allowPath(join(mnt(), "elsewhere", "inner"))).toBe(EXIT_CODES.overlapsAllowedFolder);
  });

  it.each(["back\\slash", 'double"quote', "new\nline", "tab\there"])("refuses the unsupported name %j", async (name) => {
    await mkdir(join(srv(), name));
    expect(await allowPath(join(srv(), name))).toBe(EXIT_CODES.unsupportedPath);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("\n");
  });

  it("allows spaces, quotes, colons and percent signs, which the drop-in quotes or escapes", async () => {
    const name = "it's 100% a: folder";
    await mkdir(join(srv(), name));
    expect(await allowPath(join(srv(), name))).toBe(EXIT_CODES.ok);
    expect(await readFile(dropIn(), "utf8")).toContain(`ReadWritePaths="${join(srv(), "it's 100%% a: folder")}"\n`);
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
      switchOff: 6,
      configRefused: 7,
      notAbsolute: 20,
      missing: 21,
      notAFolder: 22,
      insideDataDirectory: 23,
      insideReleaseDirectory: 24,
      insideMountRoot: 25,
      outsideAllowedFolders: 26,
      systemFolder: 27,
      unsupportedPath: 28,
      overlapsAllowedFolder: 29,
      systemdFailed: 30,
    });
  });
});
