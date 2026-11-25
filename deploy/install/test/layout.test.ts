import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HELPER_FILES,
  installScript,
  makeBundle,
  readRepoFile,
  repoRoot,
  run,
  scriptLayout,
  sourced,
  temporaryDirectory,
  type LayoutRow,
} from "./support.ts";

const ORIGIN = "https://files.example.com";
const FOLDER_RULE = "etc/polkit-1/rules.d/51-not-unreachable-allow-folder.rules";
const UPDATE_RULE = "etc/polkit-1/rules.d/52-not-unreachable-update.rules";
const UPDATE_STATE = "var/lib/not-unreachable-update";

function install(bundle: string, destdir: string, args: readonly string[] = ["--public-origin", ORIGIN, "--yes"], input = "") {
  // The host's node may not be /usr/bin/node, which a real install uses.
  return run("bash", [join(bundle, "install.sh"), ...args], { env: { DESTDIR: destdir, DESTDIR_NODE: process.execPath }, input });
}

function modeOf(path: string): string {
  return (statSync(path).mode & 0o7777).toString(8);
}

/** deployment.md's "Config, secrets and data" table, as rows. */
function documentedLayout(version: string): Omit<LayoutRow, "kind" | "optional">[] {
  const section = readRepoFile("docs/design/deployment.md").split("## Config, secrets and data")[1]?.split("\n## ")[0] ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `/"))
    .map((line) => {
      const [, pathCell = "", ownerCell = "", modeCell = ""] = line.split("|").map((cell) => cell.trim());
      const path = (/`([^`]+)`/.exec(pathCell)?.[1] ?? "").replace("<version>", version).replace(/\/$/, "");
      const owner = ownerCell.replaceAll("`", "");
      const mode = modeCell === "symlink" ? "-" : modeCell.replaceAll("`", "").replace(/^0/, "");
      return { path, owner, mode };
    });
}

describe("the layout", () => {
  it("is the one deployment.md lists, path for path, with the same owners and modes", () => {
    const script = scriptLayout("1.2.3").map(({ path, owner, mode }) => ({ path, owner, mode }));
    expect(script).toEqual(documentedLayout("1.2.3"));
  });
});

describe("an install into DESTDIR", () => {
  it("lays every path out with its mode, makes a 32-byte master key and a config with the origin", () => {
    const bundle = makeBundle("1.0.0");
    const root = temporaryDirectory();
    const installed = install(bundle, root);
    expect(installed.stderr).toBe("");
    expect(installed.status).toBe(0);
    // The script's own mode audit ran and passed.
    expect(installed.stdout).toContain("Checking the owner and mode of every installed path");

    const rows = scriptLayout("1.0.0").filter((row) => !row.optional || existsSync(join(root, row.path)));
    for (const row of rows.filter((symlink) => symlink.kind === "l")) {
      expect(lstatSync(join(root, row.path)).isSymbolicLink(), row.path).toBe(true);
    }
    for (const row of rows.filter((entry) => entry.kind !== "l")) {
      const path = join(root, row.path);
      expect(row.kind === "d" ? statSync(path).isDirectory() : statSync(path).isFile(), row.path).toBe(true);
      expect(modeOf(path), row.path).toBe(row.mode);
    }

    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.0.0");
    expect(readFileSync(join(root, "etc/not-unreachable/credentials/master.key"))).toHaveLength(32);
    const config = readFileSync(join(root, "etc/not-unreachable/config.env"), "utf8");
    expect(config).toContain(`PUBLIC_ORIGIN=${ORIGIN}\n`);
    expect(config).toContain("LISTEN_HOST=127.0.0.1\n");
    expect(config).toContain("TRUSTED_PROXIES=127.0.0.1,::1\n");
    expect(config).toContain("\nALLOW_FOLDERS_FROM_UI=false\n");
    expect(config).toContain("\nALLOWED_FOLDER_PREFIXES=/srv,/mnt\n");
    expect(config).toContain("\nUPDATE_CHECK=true\n");
    expect(config).toContain("\nUPDATE_FROM_UI=false\n");
    for (const file of HELPER_FILES) {
      expect(existsSync(join(root, "usr/lib/not-unreachable", file)), file).toBe(true);
      expect(modeOf(join(root, "usr/lib/not-unreachable", file)), file).toBe("644");
    }
    expect(existsSync(join(root, "usr/lib/not-unreachable/51-not-unreachable-allow-folder.rules"))).toBe(true);
    expect(readFileSync(join(root, "usr/lib/not-unreachable/52-not-unreachable-update.rules"), "utf8")).toBe(
      readRepoFile("deploy/polkit/52-not-unreachable-update.rules"),
    );
    expect(existsSync(join(root, FOLDER_RULE))).toBe(false);
    expect(existsSync(join(root, UPDATE_RULE))).toBe(false);
    expect(installed.stdout).toContain("ALLOW_FOLDERS_FROM_UI is off: no polkit rule");
    expect(installed.stdout).toContain("UPDATE_FROM_UI is off: no polkit rule");
    expect(readdirSync(join(root, UPDATE_STATE, "work"))).toEqual([]);
    expect(existsSync(join(root, UPDATE_STATE, "status.json"))).toBe(false);
    expect(installed.stdout).toContain(
      "Keep a copy of /etc/not-unreachable/credentials/master.key somewhere apart from the database backups.",
    );
  });

  it("keeps the release's own installer and the signing keys it trusts in the release", () => {
    const bundle = makeBundle("1.0.0");
    const root = temporaryDirectory();
    expect(install(bundle, root).status).toBe(0);
    const release = join(root, "opt/not-unreachable/1.0.0");
    expect(readdirSync(join(release, "installer")).toSorted()).toEqual(["ARCH", "VERSION", "deploy", "install.sh"]);
    expect(readFileSync(join(release, "installer/install.sh"), "utf8")).toBe(readRepoFile("deploy/install.sh"));
    expect(modeOf(join(release, "installer/install.sh"))).toBe("755");
    expect(readFileSync(join(release, "installer/VERSION"), "utf8")).toBe("1.0.0\n");
    expect(readFileSync(join(release, "installer/ARCH"), "utf8")).toBe("x64\n");
    for (const file of HELPER_FILES) expect(existsSync(join(release, "installer/deploy", file)), file).toBe(true);
    expect(readFileSync(join(release, "installer/deploy/systemd/not-unreachable.service"), "utf8")).toBe(
      readRepoFile("deploy/systemd/not-unreachable.service"),
    );

    const keys = readdirSync(join(repoRoot, "deploy/keys/release-signing")).toSorted();
    expect(keys.length).toBeGreaterThan(0);
    expect(readdirSync(join(release, "release-signing-keys")).toSorted()).toEqual(keys);
    for (const key of keys) {
      expect(readFileSync(join(release, "release-signing-keys", key), "utf8")).toBe(readRepoFile(`deploy/keys/release-signing/${key}`));
      expect(modeOf(join(release, "release-signing-keys", key))).toBe("644");
    }
  });

  it("refuses an http origin, and asks for one it isn't given only on a terminal", () => {
    const bundle = makeBundle("1.0.0");
    const http = install(bundle, temporaryDirectory(), ["--public-origin", "http://files.example.com", "--yes"]);
    expect(http.status).toBe(1);
    expect(http.stderr).toContain("must be an https origin");
    const missing = install(bundle, temporaryDirectory(), ["--yes"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--public-origin https://<host> is required with --yes");
    const noTerminal = install(bundle, temporaryDirectory(), []);
    expect(noTerminal.status).toBe(1);
    expect(noTerminal.stderr).toContain("no terminal to ask on");
  });

  it("upgrades from a newer tarball: new release, current switched, previous kept, config and key untouched", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    const key = readFileSync(join(root, "etc/not-unreachable/credentials/master.key"));
    const config = readFileSync(join(root, "etc/not-unreachable/config.env"), "utf8");

    // A different origin on the upgrade doesn't replace the config.
    const upgraded = install(makeBundle("1.1.0"), root, ["--public-origin", "https://other.example.com", "--yes"]);
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain("Keeping the master key");
    expect(upgraded.stdout).toContain("Keeping the config");
    expect(upgraded.stdout).toContain("Upgraded from 1.0.0");
    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.1.0");
    expect(existsSync(join(root, "opt/not-unreachable/1.0.0/dist/main.js"))).toBe(true);
    expect(readFileSync(join(root, "etc/not-unreachable/credentials/master.key"))).toEqual(key);
    expect(readFileSync(join(root, "etc/not-unreachable/config.env"), "utf8")).toBe(config);

    // The one before the previous is removed.
    expect(install(makeBundle("1.2.0"), root).status).toBe(0);
    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.2.0");
    expect(existsSync(join(root, "opt/not-unreachable/1.1.0"))).toBe(true);
    expect(existsSync(join(root, "opt/not-unreachable/1.0.0"))).toBe(false);
  });

  it("re-runs the same release without changing anything", () => {
    const root = temporaryDirectory();
    const bundle = makeBundle("1.0.0");
    expect(install(bundle, root).status).toBe(0);
    const key = readFileSync(join(root, "etc/not-unreachable/credentials/master.key"));
    const again = install(bundle, root);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("Upgraded from");
    expect(readFileSync(join(root, "etc/not-unreachable/credentials/master.key"))).toEqual(key);
  });

  it("keeps the release kept for a rollback when the release in use is run again", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    const upgrade = makeBundle("1.1.0");
    expect(install(upgrade, root).status).toBe(0);
    expect(install(upgrade, root).status).toBe(0);
    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.1.0");
    expect(existsSync(join(root, "opt/not-unreachable/1.0.0/dist/main.js"))).toBe(true);
  });

  it("stops at the first step of unpacking the release that fails, before switching current", () => {
    const root = temporaryDirectory();
    // A file where the release's folder goes makes the move into place fail.
    mkdirSync(join(root, "opt/not-unreachable"), { recursive: true });
    writeFileSync(join(root, "opt/not-unreachable/1.0.0"), "");
    const failed = install(makeBundle("1.0.0"), root);
    expect(failed.status).not.toBe(0);
    expect(existsSync(join(root, "opt/not-unreachable/current"))).toBe(false);
  });

  it("refuses a tarball without a valid VERSION or ARCH", () => {
    const bundle = makeBundle("1.0.0");
    run("bash", ["-c", 'printf "x86\\n" > "$0/ARCH"', bundle]);
    const refused = install(bundle, temporaryDirectory());
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("ARCH is not valid");
  });
});

/** Puts `line` in place of every (even commented) line of the switch in the installed config. */
function setSwitch(root: string, line: string, key = "ALLOW_FOLDERS_FROM_UI"): void {
  const config = join(root, "etc/not-unreachable/config.env");
  const others = readFileSync(config, "utf8").replace(new RegExp(`^[ \\t]*#?[ \\t]*${key}[ \\t]*=.*\\n`, "gmu"), "");
  writeFileSync(config, `${others}${line}\n`);
}

describe("the allow-folder polkit rule", () => {
  it("is active only while config.env has ALLOW_FOLDERS_FROM_UI=true, checked on every run", () => {
    const root = temporaryDirectory();
    const bundle = makeBundle("1.0.0");
    expect(install(bundle, root).status).toBe(0);

    setSwitch(root, 'ALLOW_FOLDERS_FROM_UI="true"');
    const on = install(bundle, root);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("ALLOW_FOLDERS_FROM_UI=true: installing the polkit rule");
    expect(readFileSync(join(root, FOLDER_RULE), "utf8")).toBe(readRepoFile("deploy/polkit/51-not-unreachable-allow-folder.rules"));
    expect(modeOf(join(root, FOLDER_RULE))).toBe("644");

    // Each run starts with the rule in place, as one left behind by hand: an install removes it.
    for (const off of ["ALLOW_FOLDERS_FROM_UI=false", "ALLOW_FOLDERS_FROM_UI=True", "#ALLOW_FOLDERS_FROM_UI=true", ""]) {
      writeFileSync(join(root, FOLDER_RULE), readRepoFile("deploy/polkit/51-not-unreachable-allow-folder.rules"));
      setSwitch(root, off);
      expect(install(bundle, root).status, off).toBe(0);
      expect(existsSync(join(root, FOLDER_RULE)), off).toBe(false);
    }
  });

  it("is never turned on by an upgrade, whose config is kept", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    const config = join(root, "etc/not-unreachable/config.env");
    // A config from before the switch existed.
    writeFileSync(config, readFileSync(config, "utf8").replace(/^ALLOW.*\n/gmu, ""));
    const before = readFileSync(config, "utf8");
    expect(install(makeBundle("1.1.0"), root).status).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(existsSync(join(root, FOLDER_RULE))).toBe(false);
  });

  it("takes the last of several switch lines, as systemd does", () => {
    const root = temporaryDirectory();
    const bundle = makeBundle("1.0.0");
    expect(install(bundle, root).status).toBe(0);
    setSwitch(root, "ALLOW_FOLDERS_FROM_UI=true\n  ALLOW_FOLDERS_FROM_UI = false ");
    expect(install(bundle, root).status).toBe(0);
    expect(existsSync(join(root, FOLDER_RULE))).toBe(false);
    setSwitch(root, "ALLOW_FOLDERS_FROM_UI=false\nALLOW_FOLDERS_FROM_UI='true'");
    expect(install(bundle, root).status).toBe(0);
    expect(existsSync(join(root, FOLDER_RULE))).toBe(true);
  });
});

describe("the update polkit rule", () => {
  it("is active only while config.env has UPDATE_FROM_UI=true, checked on every run", () => {
    const root = temporaryDirectory();
    const bundle = makeBundle("1.0.0");
    expect(install(bundle, root).status).toBe(0);

    setSwitch(root, 'UPDATE_FROM_UI="true"', "UPDATE_FROM_UI");
    const on = install(bundle, root);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("UPDATE_FROM_UI=true: installing the polkit rule");
    expect(readFileSync(join(root, UPDATE_RULE), "utf8")).toBe(readRepoFile("deploy/polkit/52-not-unreachable-update.rules"));
    expect(modeOf(join(root, UPDATE_RULE))).toBe("644");
    // The other switch is apart.
    expect(existsSync(join(root, FOLDER_RULE))).toBe(false);

    // Each run starts with the rule in place, as one left behind by hand: an install removes it.
    for (const off of ["UPDATE_FROM_UI=false", "UPDATE_FROM_UI=True", "#UPDATE_FROM_UI=true", ""]) {
      writeFileSync(join(root, UPDATE_RULE), readRepoFile("deploy/polkit/52-not-unreachable-update.rules"));
      setSwitch(root, off, "UPDATE_FROM_UI");
      expect(install(bundle, root).status, off).toBe(0);
      expect(existsSync(join(root, UPDATE_RULE)), off).toBe(false);
    }
  });

  it("is never turned on by an upgrade, whose config is kept", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    const config = join(root, "etc/not-unreachable/config.env");
    // A config from before the switches existed.
    writeFileSync(config, readFileSync(config, "utf8").replace(/^(UPDATE|ALLOW).*\n/gmu, ""));
    const before = readFileSync(config, "utf8");
    expect(install(makeBundle("1.1.0"), root).status).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(existsSync(join(root, UPDATE_RULE))).toBe(false);
  });
});

describe("the system files install.sh owns", () => {
  it("are the ones the release ships: owned files it doesn't ship go, others stay", () => {
    const root = temporaryDirectory();
    const bundle = makeBundle("1.0.0");
    expect(install(bundle, root).status).toBe(0);
    const owned = [
      "etc/systemd/system/not-unreachable-retired.service",
      "etc/systemd/system/not-unreachable-retired.timer",
      "etc/polkit-1/rules.d/53-not-unreachable-retired.rules",
      "usr/lib/not-unreachable/retired-helper.mjs",
      "usr/lib/not-unreachable/53-not-unreachable-retired.rules",
    ];
    const others = [
      "etc/systemd/system/other.service",
      "etc/systemd/system/not-unreachable.service.d/resources.conf",
      "etc/polkit-1/rules.d/49-other.rules",
      "etc/polkit-1/rules.d/60-not-unreachable-local.rules",
    ];
    for (const file of [...owned, ...others]) writeFileSync(join(root, file), "");
    mkdirSync(join(root, "usr/lib/not-unreachable/retired-folder"));

    const again = install(bundle, root);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Removing /etc/systemd/system/not-unreachable-retired.service, which this release doesn't ship");
    for (const file of owned) expect(existsSync(join(root, file)), file).toBe(false);
    expect(existsSync(join(root, "usr/lib/not-unreachable/retired-folder"))).toBe(false);
    for (const file of others) expect(existsSync(join(root, file)), file).toBe(true);
    for (const unit of ["not-unreachable-update.service", "not-unreachable-update-apply.service"]) {
      expect(readFileSync(join(root, "etc/systemd/system", unit), "utf8")).toBe(readRepoFile(`deploy/systemd/${unit}`));
    }
  });
});

describe("the kept installer", () => {
  it("rolls back: puts its release's system files back and switches current to it", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    expect(install(makeBundle("1.1.0"), root).status).toBe(0);
    // Something only 1.1.0 would have shipped.
    writeFileSync(join(root, "usr/lib/not-unreachable/only-in-1.1.0.mjs"), "");

    const rolledBack = install(join(root, "opt/not-unreachable/1.0.0/installer"), root, ["--yes"]);
    expect(rolledBack.stderr).toBe("");
    expect(rolledBack.status).toBe(0);
    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.0.0");
    // The release it replaced stays, for going forward again.
    expect(existsSync(join(root, "opt/not-unreachable/1.1.0/dist/main.js"))).toBe(true);
    expect(existsSync(join(root, "usr/lib/not-unreachable/only-in-1.1.0.mjs"))).toBe(false);
    expect(rolledBack.stdout).toContain("Checking the owner and mode of every installed path");
  });
});

describe("--apply-update", () => {
  it("upgrades without asking, starting nothing and printing no setup link", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    const config = readFileSync(join(root, "etc/not-unreachable/config.env"), "utf8");
    const applied = install(makeBundle("1.1.0"), root, ["--apply-update"]);
    expect(applied.stderr).toBe("");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("NotUnreachable 1.1.0 is installed; the update helper restarts the service.");
    expect(applied.stdout).not.toContain("setup");
    expect(applied.stdout).toContain("Checking the owner and mode of every installed path");
    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.1.0");
    expect(existsSync(join(root, "opt/not-unreachable/1.1.0/installer/install.sh"))).toBe(true);
    expect(readFileSync(join(root, "etc/not-unreachable/config.env"), "utf8")).toBe(config);
  });

  it("syncs both rules with their switches", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    setSwitch(root, "UPDATE_FROM_UI=true", "UPDATE_FROM_UI");
    setSwitch(root, "ALLOW_FOLDERS_FROM_UI=true");
    expect(install(makeBundle("1.1.0"), root, ["--apply-update"]).status).toBe(0);
    expect(existsSync(join(root, UPDATE_RULE))).toBe(true);
    expect(existsSync(join(root, FOLDER_RULE))).toBe(true);
  });

  it("exits 3, changing nothing, where there is no install to upgrade", () => {
    const root = temporaryDirectory();
    const refused = install(makeBundle("1.1.0"), root, ["--apply-update"]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("--apply-update only upgrades an install");
    expect(readdirSync(root)).toEqual([]);
  });

  it("exits 3, changing nothing, without a service user", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    run("rm", [join(root, "usr/lib/sysusers.d/not-unreachable.conf")]);
    const refused = install(makeBundle("1.1.0"), root, ["--apply-update"]);
    expect(refused.status).toBe(3);
    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.0.0");
    expect(existsSync(join(root, "opt/not-unreachable/1.1.0"))).toBe(false);
  });

  it("exits 1 when it fails once it has changed something", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    writeFileSync(join(root, "opt/not-unreachable/1.1.0"), "");
    const failed = install(makeBundle("1.1.0"), root, ["--apply-update"]);
    expect(failed.status).toBe(1);
    expect(readlinkSync(join(root, "opt/not-unreachable/current"))).toBe("1.0.0");
  });

  it.each([
    [true, 3, 3],
    [false, 3, 1],
    [false, 2, 1],
    [true, 0, 0],
  ])("with nothing changed %s, turns exit %i into %i", (nothingChanged, status, expected) => {
    const exited = sourced(installScript, `NOTHING_CHANGED=${nothingChanged}; trap apply_update_exit EXIT; exit ${status}`);
    expect(exited.status).toBe(expected);
  });

  it("exits 3 for a Node it can't use, as for any other check before changing anything", () => {
    expect(sourced(installScript, "DIE_STATUS=3; check_node v26.1.0").status).toBe(3);
  });

  it("takes no other option", () => {
    const refused = install(makeBundle("1.1.0"), temporaryDirectory(), ["--apply-update", "--public-origin", ORIGIN]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--apply-update takes no other option");
  });
});

/** A status file of an update from Settings, as the update helper writes it, in a phase before finished. */
const status = (phase: string) => ({
  schema: 1,
  requestId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  from: "1.0.0",
  to: "1.1.0",
  phase,
  result: null,
  reason: null,
  signingKey: "3fa9c01e7b2d4c55",
  startedAt: "2026-11-25T14:02:11.000Z",
  updatedAt: "2026-11-25T14:02:40.000Z",
  finishedAt: null,
});

/** An install of 1.0.0 with an update from Settings to 1.1.0 left in the phase, its lock and work folder. */
function interrupted(phase: string): string {
  const root = temporaryDirectory();
  expect(install(makeBundle("1.0.0"), root).status).toBe(0);
  writeFileSync(join(root, UPDATE_STATE, "status.json"), JSON.stringify(status(phase)));
  writeFileSync(join(root, UPDATE_STATE, "work/lock"), "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b\n");
  mkdirSync(join(root, UPDATE_STATE, "work/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b/staged"), { recursive: true });
  return root;
}

describe("an interrupted update from Settings", () => {
  it.each(["verifying", "verified", "installing", "restarting", "rolling-back"])(
    "in phase %s is ended by an install over SSH: no lock, no work, the status interrupted",
    (phase) => {
      const root = interrupted(phase);
      const upgraded = install(makeBundle("1.1.0"), root);
      expect(upgraded.status).toBe(0);
      expect(upgraded.stdout).toContain("Ending the update from Settings that stopped half-way");
      expect(readdirSync(join(root, UPDATE_STATE, "work"))).toEqual([]);
      expect(modeOf(join(root, UPDATE_STATE, "work"))).toBe("700");
      // Still valid against the server's schema (updateStatusFileSchema): the same keys, a result, a
      // reason and a finish time once finished.
      const written = readFileSync(join(root, UPDATE_STATE, "status.json"), "utf8");
      const finishedAt = /"finishedAt":"([^"]+)"/u.exec(written)?.[1];
      expect(JSON.parse(written)).toStrictEqual({
        ...status(phase),
        phase: "finished",
        result: "interrupted",
        reason: "interrupted",
        updatedAt: finishedAt,
        finishedAt,
      });
      expect(finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      expect(modeOf(join(root, UPDATE_STATE, "status.json"))).toBe("644");
      expect(readdirSync(join(root, UPDATE_STATE)).toSorted()).toEqual(["status.json", "work"]);
    },
  );

  it("leaves a finished update's status as it is", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root).status).toBe(0);
    const finished = JSON.stringify({ ...status("finished"), result: "succeeded", finishedAt: "2026-11-25T14:03:40.000Z" });
    writeFileSync(join(root, UPDATE_STATE, "status.json"), finished);
    expect(install(makeBundle("1.1.0"), root).status).toBe(0);
    expect(readFileSync(join(root, UPDATE_STATE, "status.json"), "utf8")).toBe(finished);
  });

  it("is left to the apply unit under --apply-update, which holds the lock itself", () => {
    const root = interrupted("installing");
    expect(install(makeBundle("1.1.0"), root, ["--apply-update"]).status).toBe(0);
    expect(existsSync(join(root, UPDATE_STATE, "work/lock"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, UPDATE_STATE, "status.json"), "utf8"))).toMatchObject({ phase: "installing" });
  });
});

/**
 * Runs hold_updates on a temp runtime unit folder, then the rest of the snippet, with systemctl a fake
 * that notes what it was asked in `calls` and answers is-active with the state.
 */
function holdUpdates(rest: string, state = "inactive") {
  const runtime = temporaryDirectory();
  const log = join(temporaryDirectory(), "systemctl.log");
  const fake = `systemctl() { echo "systemctl $*" >>"${log}"; [[ "$1" != is-active ]] || { echo ${state}; [[ ${state} == active ]]; }; }`;
  const ran = sourced(installScript, `${fake}; hold_updates "${runtime}"; echo "the rest" >>"${log}"; ${rest}`);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { ran, runtime, calls };
}

const HOLD_DROP_INS = ["not-unreachable-update.service.d", "not-unreachable-update-apply.service.d"].map(
  (folder) => `${folder}/50-install-running.conf`,
);

describe("an install over SSH holds updates from Settings", () => {
  it("refuses a start of either update unit while it runs, and stops refusing when it ends", () => {
    const { ran, runtime, calls } = holdUpdates("exit 0");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(calls()).toEqual([
      "systemctl daemon-reload",
      "systemctl is-active not-unreachable-update.service",
      "systemctl is-active not-unreachable-update-apply.service",
      "the rest",
      "systemctl daemon-reload",
    ]);
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("puts a RefuseManualStart drop-in on both update units meanwhile", () => {
    const runtime = temporaryDirectory();
    const fake = 'systemctl() { [[ "$1" != is-active ]] || { echo inactive; return 3; }; }';
    const ran = sourced(
      installScript,
      `${fake}; hold_updates "${runtime}"; cat ${HOLD_DROP_INS.map((file) => `"${join(runtime, file)}"`).join(" ")}`,
    );
    expect(ran.status).toBe(0);
    expect(ran.stdout.match(/^\[Unit\]\nRefuseManualStart=yes$/gmu)).toHaveLength(2);
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("stops holding them when the install fails, keeping its exit status", () => {
    const { ran, runtime, calls } = holdUpdates("die boom");
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("boom");
    expect(calls().at(-1)).toBe("systemctl daemon-reload");
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("stops holding them when a command fails under set -e", () => {
    const { ran, runtime } = holdUpdates("false");
    expect(ran.status).toBe(1);
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("refuses to run while an update is running, and stops holding them", () => {
    const { ran, runtime, calls } = holdUpdates("exit 0", "active");
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("an update from Settings is running (not-unreachable-update.service is active)");
    expect(ran.stderr).toContain("Nothing was changed.");
    expect(calls()).not.toContain("the rest");
    expect(calls().at(-1)).toBe("systemctl daemon-reload");
    expect(readdirSync(runtime)).toEqual([]);
  });
});

function freshInstall(): { root: string; bundle: string } {
  const root = temporaryDirectory();
  const bundle = makeBundle("1.0.0");
  expect(install(bundle, root).status).toBe(0);
  return { root, bundle };
}

describe("--uninstall", () => {
  it("removes the units, the polkit rules, the CLI, the helpers and /opt, and keeps config and data", () => {
    const { root, bundle } = freshInstall();
    // The active allow-folder rule goes too.
    run("bash", [
      "-c",
      'sed -i "s/^ALLOW_FOLDERS_FROM_UI=.*/ALLOW_FOLDERS_FROM_UI=true/; s/^UPDATE_FROM_UI=.*/UPDATE_FROM_UI=true/" "$0"',
      join(root, "etc/not-unreachable/config.env"),
    ]);
    expect(install(bundle, root).status).toBe(0);
    expect(existsSync(join(root, FOLDER_RULE))).toBe(true);
    expect(existsSync(join(root, UPDATE_RULE))).toBe(true);
    const removed = install(bundle, root, ["--uninstall"]);
    expect(removed.status).toBe(0);
    for (const gone of [
      "opt/not-unreachable",
      "usr/local/bin/not-unreachable",
      "usr/lib/not-unreachable",
      "etc/systemd/system/not-unreachable.service",
      "etc/systemd/system/not-unreachable-backup.timer",
      "etc/systemd/system/not-unreachable-mount@.service",
      "etc/systemd/system/not-unreachable-allow-folder.service",
      "etc/systemd/system/not-unreachable-update.service",
      "etc/systemd/system/not-unreachable-update-apply.service",
      "etc/polkit-1/rules.d/50-not-unreachable.rules",
      FOLDER_RULE,
      UPDATE_RULE,
      UPDATE_STATE,
    ]) {
      expect(existsSync(join(root, gone)), gone).toBe(false);
    }
    for (const kept of [
      "etc/not-unreachable/config.env",
      "etc/not-unreachable/credentials/master.key",
      "var/lib/not-unreachable/db",
      "etc/systemd/system/not-unreachable.service.d",
    ]) {
      expect(existsSync(join(root, kept)), kept).toBe(true);
    }
  });

  it("with --purge, removes config and data only after the typed confirmation", () => {
    const { root, bundle } = freshInstall();
    const unconfirmed = install(bundle, root, ["--uninstall", "--purge"], "yes\n");
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stderr).toContain("nothing was removed");
    expect(existsSync(join(root, "opt/not-unreachable"))).toBe(true);
    expect(existsSync(join(root, "etc/not-unreachable/credentials/master.key"))).toBe(true);

    const purged = install(bundle, root, ["--uninstall", "--purge"], "delete everything\n");
    expect(purged.status).toBe(0);
    for (const gone of ["etc/not-unreachable", "var/lib/not-unreachable", "opt/not-unreachable"]) {
      expect(existsSync(join(root, gone)), gone).toBe(false);
    }
  });

  it("takes --purge only with --uninstall", () => {
    const purge = install(makeBundle("1.0.0"), temporaryDirectory(), ["--purge"]);
    expect(purge.status).toBe(1);
    expect(purge.stderr).toContain("--purge goes with --uninstall");
  });
});
