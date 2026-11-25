import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliWrapper, run, sourced, temporaryDirectory } from "./support.ts";

/**
 * Runs the wrapper's `main` with systemd-run, systemctl, find and id replaced by fakes that print
 * what they were asked, so the test sees which commands run as root and which as the service user.
 */
function dispatch(args: string, options: { uid?: number; serviceActive?: boolean; hardlinksProtected?: boolean } = {}) {
  const fakes = [
    `id() { echo ${options.uid ?? 0}; }`,
    'systemd-run() { printf "systemd-run"; printf " [%s]" "$@"; printf "\\n"; }',
    `systemctl() { echo "systemctl $*"; [[ "$1" != is-active ]] || return ${options.serviceActive === true ? 0 : 3}; }`,
    'find() { echo "find $*"; }',
    `sysctl_enabled() { echo "sysctl_enabled $*"; return ${options.hardlinksProtected === false ? 1 : 0}; }`,
    // It changes files in /etc; the tests below run it on temp files.
    'switch_folders_from_ui() { echo "switch_folders_from_ui $*"; }',
    'switch_update_from_ui() { echo "switch_update_from_ui $*"; }',
  ].join("; ");
  return sourced(cliWrapper, `${fakes}; main ${args}`);
}

const SERVICE_USER = "[-p] [User=not-unreachable]";
const CREDENTIAL = "[-p] [LoadCredential=master.key:/etc/not-unreachable/credentials/master.key]";

describe("the CLI wrapper", () => {
  it.each(["migrate", "backup", "setup-link", "reset-admin --second-factors"])(
    "runs %s as the service user, in the service's sandbox, with the master key credential",
    (command) => {
      const ran = dispatch(command);
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain(SERVICE_USER);
      expect(ran.stdout).toContain(CREDENTIAL);
      expect(ran.stdout).toContain("[-p] [ProtectSystem=strict]");
      expect(ran.stdout).toContain("[-p] [EnvironmentFile=/etc/not-unreachable/config.env]");
      expect(ran.stdout).not.toContain("RuntimeDirectory");
      expect(ran.stdout).toContain(`[--] [/usr/bin/node] [--disable-proto=delete] [dist/cli.js] [${command.split(" ").join("] [")}]`);
    },
  );

  it("runs allow-folder as root, with the config and nothing of the sandbox", () => {
    const ran = dispatch("allow-folder /srv/media");
    expect(ran.status).toBe(0);
    expect(ran.stdout).not.toContain("User=");
    expect(ran.stdout).not.toContain("LoadCredential");
    expect(ran.stdout).toContain("[-p] [EnvironmentFile=/etc/not-unreachable/config.env]");
    expect(ran.stdout).toContain("[dist/cli.js] [allow-folder] [/srv/media]");
  });

  it("runs rotate-key as root once the service is stopped, then gives the data back to the service user", () => {
    const ran = dispatch("rotate-key");
    expect(ran.status).toBe(0);
    expect(ran.stdout).not.toContain("User=");
    expect(ran.stdout).toContain("[dist/cli.js] [rotate-key]");
    expect(ran.stdout).toContain("find /var/lib/not-unreachable -xdev -user root -exec chown -h not-unreachable:not-unreachable {} +");
  });

  // Giving the data back chowns as root inside the service user's folder: a hard link there to
  // /etc/shadow would hand it to the service user unless the kernel refuses to make such a link.
  it("refuses rotate-key, before changing anything, while fs.protected_hardlinks is off", () => {
    const ran = dispatch("rotate-key", { hardlinksProtected: false });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain("sysctl_enabled /proc/sys/fs/protected_hardlinks");
    expect(ran.stderr).toContain("fs.protected_hardlinks");
    expect(ran.stdout).not.toContain("systemd-run");
    expect(ran.stdout).not.toContain("find ");
  });

  it.each([
    ["1\n", 0],
    ["1", 0],
    ["0\n", 1],
    ["", 1],
  ])("reads the sysctl file %j as %i", (content, status) => {
    const file = join(temporaryDirectory(), "protected_hardlinks");
    writeFileSync(file, content);
    expect(sourced(cliWrapper, `sysctl_enabled "${file}"`).status).toBe(status);
  });

  it("treats a sysctl file it can't read as off", () => {
    expect(sourced(cliWrapper, `sysctl_enabled "${join(temporaryDirectory(), "missing")}"`).status).toBe(1);
  });

  it("refuses rotate-key while the service runs", () => {
    const ran = dispatch("rotate-key", { serviceActive: true });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("stop the service first");
    expect(ran.stdout).not.toContain("systemd-run");
  });

  it("refuses anyone but root", () => {
    const ran = dispatch("setup-link", { uid: 1000 });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("run it as root");
    expect(ran.stdout).not.toContain("systemd-run");
  });

  it("refuses an unknown command with the usage exit code", () => {
    const ran = dispatch("drop-database");
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("unknown command: drop-database");
  });

  it("asks systemd-run for a pipe without a terminal", () => {
    expect(dispatch("setup-link").stdout).toContain("[--pipe]");
  });

  it.each(["on", "off"])("runs allow-folders-from-ui %s as root, in this script, on the installed paths", (state) => {
    const ran = dispatch(`allow-folders-from-ui ${state}`);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(
      `switch_folders_from_ui ${state} /etc/not-unreachable/config.env /usr/lib/not-unreachable/51-not-unreachable-allow-folder.rules /etc/polkit-1/rules.d/51-not-unreachable-allow-folder.rules\n`,
    );
  });

  it.each(["", "yes", "true", "on off", "ON"])("refuses allow-folders-from-ui %j with the usage exit code", (args) => {
    const ran = dispatch(`allow-folders-from-ui ${args}`);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("allow-folders-from-ui on|off");
    expect(ran.stdout).toBe("");
  });

  it("refuses allow-folders-from-ui to anyone but root", () => {
    const ran = dispatch("allow-folders-from-ui on", { uid: 1000 });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("run it as root");
  });

  it.each(["on", "off"])("runs update-from-ui %s as root, in this script, on the installed paths", (state) => {
    const ran = dispatch(`update-from-ui ${state}`);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(
      `switch_update_from_ui ${state} /etc/not-unreachable/config.env /usr/lib/not-unreachable/52-not-unreachable-update.rules /etc/polkit-1/rules.d/52-not-unreachable-update.rules\n`,
    );
  });

  it.each(["", "yes", "true", "on off", "ON"])("refuses update-from-ui %j with the usage exit code", (args) => {
    const ran = dispatch(`update-from-ui ${args}`);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("update-from-ui on|off");
    expect(ran.stdout).toBe("");
  });

  it.each(["update-from-ui on", "update-recover"])("refuses %s to anyone but root", (command) => {
    const ran = dispatch(command, { uid: 1000 });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("run it as root");
    expect(ran.stdout).not.toContain("systemctl");
  });

  it("runs update-recover as root: starts the apply unit, which it waits for", () => {
    const ran = dispatch("update-recover");
    expect(ran.status).toBe(0);
    const systemctl = ran.stdout.split("\n").filter((line) => line.startsWith("systemctl "));
    // A oneshot unit's start returns once it has run; --no-block would not wait.
    expect(systemctl).toEqual(["systemctl start not-unreachable-update-apply.service"]);
    expect(ran.stdout).not.toContain("systemd-run");
  });

  it("refuses update-recover with arguments", () => {
    const ran = dispatch("update-recover now");
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe("");
  });

  it("fails update-recover when the apply unit fails", () => {
    const ran = sourced(cliWrapper, 'id() { echo 0; }; systemctl() { echo "systemctl $*"; return 1; }; main update-recover');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("not-unreachable-update-apply.service failed");
  });
});

const CONFIG =
  "# NotUnreachable bootstrap config\nPUBLIC_ORIGIN=https://files.example.com\nALLOW_FOLDERS_FROM_UI=false\nALLOWED_FOLDER_PREFIXES=/srv,/mnt\n";

/**
 * Runs switch_folders_from_ui on temp files, with chown, install and systemctl replaced by fakes that
 * print what they were asked (the test doesn't run as root), install copying the file.
 */
function switchFolders(
  state: string,
  options: {
    config?: string | undefined;
    rule?: boolean;
    polkitFails?: boolean;
    serviceFails?: boolean;
    command?: "switch_folders_from_ui" | "switch_update_from_ui";
  } = {},
) {
  const dir = temporaryDirectory();
  const config = join(dir, "config.env");
  const source = join(dir, "51-not-unreachable-allow-folder.rules");
  const rule = join(dir, "rules.d", "51-not-unreachable-allow-folder.rules");
  if (options.config !== undefined) writeFileSync(config, options.config, { mode: 0o640 });
  writeFileSync(source, "// the rule\n");
  if (options.rule === true) {
    run("mkdir", [join(dir, "rules.d")]);
    writeFileSync(rule, "// the rule\n");
  }
  const fakes = [
    'chown() { echo "chown $*"; }',
    'install() { echo "install $*"; mkdir -p "$(dirname "${@: -1}")"; cp "${@: -2:1}" "${@: -1}"; }',
    `systemctl() { echo "systemctl $*"; case "$2" in polkit.service) return ${options.polkitFails === true ? 1 : 0} ;; *) return ${options.serviceFails === true ? 1 : 0} ;; esac; }`,
  ].join("; ");
  const ran = sourced(cliWrapper, `${fakes}; ${options.command ?? "switch_folders_from_ui"} "${state}" "${config}" "${source}" "${rule}"`);
  return { ran, dir, config, rule };
}

describe("allow-folders-from-ui", () => {
  it("on: sets the switch, installs the rule as root's, restarts polkit, then the service if it runs", () => {
    const { ran, dir, config, rule } = switchFolders("on", { config: CONFIG });
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(CONFIG.replace("ALLOW_FOLDERS_FROM_UI=false", "ALLOW_FOLDERS_FROM_UI=true"));
    expect((statSync(config).mode & 0o7777).toString(8)).toBe("640");
    expect(existsSync(rule)).toBe(true);
    expect(ran.stdout).toContain("chown root:not-unreachable");
    expect(ran.stdout).toContain(`install -m 0644 -o root -g root ${join(dir, "51-not-unreachable-allow-folder.rules")} ${rule}`);
    const systemctl = ran.stdout.split("\n").filter((line) => line.startsWith("systemctl "));
    expect(systemctl).toEqual(["systemctl restart polkit.service", "systemctl try-restart not-unreachable.service"]);
    expect(ran.stdout).toContain("Set ALLOW_FOLDERS_FROM_UI=true");
    // No temp file is left next to the config.
    expect(
      run("ls", ["-A", dir])
        .stdout.split("\n")
        .filter((name) => name.startsWith(".config.env")),
    ).toEqual([]);
  });

  it("off: removes the rule first, then sets the switch off", () => {
    const { ran, config, rule } = switchFolders("off", { config: CONFIG.replace("=false", "=true"), rule: true });
    expect(ran.status).toBe(0);
    expect(existsSync(rule)).toBe(false);
    expect(readFileSync(config, "utf8")).toBe(CONFIG);
    expect(ran.stdout).toContain("Removed the polkit rule");
    expect(ran.stdout).toContain("systemctl try-restart not-unreachable.service");
  });

  it("appends the switch when the config has none, and keeps every other line", () => {
    const { ran, config } = switchFolders("on", { config: "PUBLIC_ORIGIN=https://files.example.com\nLOG_LEVEL=info" });
    expect(ran.status).toBe(0);
    expect(readFileSync(config, "utf8")).toBe("PUBLIC_ORIGIN=https://files.example.com\nLOG_LEVEL=info\nALLOW_FOLDERS_FROM_UI=true\n");
  });

  it("replaces the first switch line, however spaced, and drops later ones", () => {
    const { ran, config } = switchFolders("off", {
      config: "  ALLOW_FOLDERS_FROM_UI = true\nLOG_LEVEL=info\nALLOW_FOLDERS_FROM_UI=true\n# ALLOW_FOLDERS_FROM_UI=true\n",
    });
    expect(ran.status).toBe(0);
    expect(readFileSync(config, "utf8")).toBe("ALLOW_FOLDERS_FROM_UI=false\nLOG_LEVEL=info\n# ALLOW_FOLDERS_FROM_UI=true\n");
  });

  it("changes nothing without a config", () => {
    const { ran, rule } = switchFolders("on");
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("install NotUnreachable first");
    expect(existsSync(rule)).toBe(false);
    expect(ran.stdout).not.toContain("systemctl");
  });

  it("only warns when polkit doesn't restart", () => {
    const { ran } = switchFolders("on", { config: CONFIG, polkitFails: true });
    expect(ran.status).toBe(0);
    expect(ran.stderr).toContain("could not restart polkit");
    expect(ran.stdout).toContain("systemctl try-restart not-unreachable.service");
  });

  it("fails when the service doesn't restart", () => {
    const { ran } = switchFolders("off", { config: CONFIG, serviceFails: true });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("did not restart");
  });
});

describe("update-from-ui", () => {
  const config = `${CONFIG}UPDATE_CHECK=true\nUPDATE_FROM_UI=false\n`;

  it("on: sets UPDATE_FROM_UI alone, installs the rule, restarts polkit, then the service if it runs", () => {
    const { ran, config: file, rule } = switchFolders("on", { config, command: "switch_update_from_ui" });
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(config.replace("UPDATE_FROM_UI=false", "UPDATE_FROM_UI=true"));
    expect((statSync(file).mode & 0o7777).toString(8)).toBe("640");
    expect(existsSync(rule)).toBe(true);
    const systemctl = ran.stdout.split("\n").filter((line) => line.startsWith("systemctl "));
    expect(systemctl).toEqual(["systemctl restart polkit.service", "systemctl try-restart not-unreachable.service"]);
    expect(ran.stdout).toContain("Set UPDATE_FROM_UI=true");
  });

  it("off: removes the rule first, then sets the switch off, leaving ALLOW_FOLDERS_FROM_UI", () => {
    const on = config
      .replace("UPDATE_FROM_UI=false", "UPDATE_FROM_UI=true")
      .replace("ALLOW_FOLDERS_FROM_UI=false", "ALLOW_FOLDERS_FROM_UI=true");
    const { ran, config: file, rule } = switchFolders("off", { config: on, rule: true, command: "switch_update_from_ui" });
    expect(ran.status).toBe(0);
    expect(existsSync(rule)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(config.replace("ALLOW_FOLDERS_FROM_UI=false", "ALLOW_FOLDERS_FROM_UI=true"));
    expect(ran.stdout).toContain("Removed the polkit rule");
  });

  it("appends the switch to a config from before it existed", () => {
    const { ran, config: file } = switchFolders("on", { config: CONFIG, command: "switch_update_from_ui" });
    expect(ran.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(`${CONFIG}UPDATE_FROM_UI=true\n`);
  });
});
