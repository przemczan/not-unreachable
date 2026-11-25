import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliWrapper, installScript, readRepoFile, repoRoot, run, sourced } from "./support.ts";

/** A unit's settings in one section, as `Key=Value` lines, in order; comments and blanks left out. */
function settings(unit: string, section: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const line of unit.split("\n")) {
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) current = header[1] ?? "";
    else if (current === section && line.trim() !== "" && !line.startsWith("#")) lines.push(line);
  }
  return lines;
}

const keyOf = (setting: string) => setting.slice(0, setting.indexOf("="));

const serviceUnit = readRepoFile("deploy/systemd/not-unreachable.service");
const backupUnit = readRepoFile("deploy/systemd/not-unreachable-backup.service");
const backupTimer = readRepoFile("deploy/systemd/not-unreachable-backup.timer");
const allowFolderUnit = readRepoFile("deploy/systemd/not-unreachable-allow-folder.service");
const updateUnit = readRepoFile("deploy/systemd/not-unreachable-update.service");
const updateApplyUnit = readRepoFile("deploy/systemd/not-unreachable-update-apply.service");

/** Every value a setting has in the section, split at spaces, as systemd adds up list settings. */
function values(unit: string, section: string, key: string): string[] {
  return settings(unit, section)
    .filter((setting) => keyOf(setting) === key)
    .flatMap((setting) => setting.slice(key.length + 1).split(/\s+/u))
    .filter((value) => value !== "");
}

/** A readonly variable of deploy/install.sh. */
function installSetting(name: string): string {
  const printed = sourced(installScript, `printf '%s' "$${name}"`);
  if (printed.status !== 0) throw new Error(printed.stderr);
  return printed.stdout;
}

/** Settings only the long-running service has (deploy/bin/not-unreachable says why). */
const SERVICE_ONLY = new Set([
  "Type",
  "NotifyAccess",
  "ExecStart",
  "RuntimeDirectory",
  "RuntimeDirectoryMode",
  "Restart",
  "RestartSec",
  "TimeoutStopSec",
  "RemoveIPC",
  "LimitNOFILE",
]);

describe("not-unreachable.service", () => {
  it("is deployment.md's unit, line for line", () => {
    const documented = /## systemd unit[\s\S]*?```ini\n([\s\S]*?)```/.exec(readRepoFile("docs/design/deployment.md"))?.[1];
    const unitWithoutHeader = serviceUnit.replace(/^(#.*\n)+/, "");
    expect(unitWithoutHeader).toBe(documented);
  });

  it("starts as Type=notify, as the service user, with the master key as a credential", () => {
    const service = settings(serviceUnit, "Service");
    expect(service).toContain("Type=notify");
    expect(service).toContain("User=not-unreachable");
    expect(service).toContain("LoadCredential=master.key:/etc/not-unreachable/credentials/master.key");
  });
});

describe("the backup unit and timer", () => {
  it("runs `backup` daily, catching up on missed runs", () => {
    expect(settings(backupTimer, "Timer")).toEqual(expect.arrayContaining(["OnCalendar=daily", "Persistent=true"]));
    expect(settings(backupTimer, "Install")).toEqual(["WantedBy=timers.target"]);
    expect(settings(backupUnit, "Service")).toContain("ExecStart=/usr/bin/node --disable-proto=delete dist/cli.js backup");
  });

  it("has the service's hardening, user, config and credential", () => {
    const expected = settings(serviceUnit, "Service").filter(
      (setting) => !SERVICE_ONLY.has(keyOf(setting)) && keyOf(setting) !== "ReadWritePaths",
    );
    const backup = settings(backupUnit, "Service").filter((setting) => !["Type", "ExecStart", "TimeoutStartSec"].includes(keyOf(setting)));
    expect(backup).toEqual(expected);
  });
});

describe("the folder helper's unit", () => {
  const service = settings(allowFolderUnit, "Service");

  it("runs the folder helper once per start, as root, and is never enabled", () => {
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/bin/node /usr/lib/not-unreachable/folder-helper.mjs allow");
    expect(service.map(keyOf)).not.toContain("RemainAfterExit");
    expect(service.map(keyOf)).not.toContain("User");
    expect(allowFolderUnit).not.toMatch(/^\[Install\]$/mu);
  });

  it("keeps one capability and writes only to the drop-in folder install.sh makes", () => {
    expect(service).toContain("CapabilityBoundingSet=CAP_DAC_READ_SEARCH");
    expect(service).toContain("AmbientCapabilities=");
    expect(service).toContain("ProtectSystem=strict");
    expect(service.filter((setting) => keyOf(setting) === "ReadWritePaths")).toEqual([`ReadWritePaths=${installSetting("DROP_IN_DIR")}`]);
  });

  it("is in install.sh's units", () => {
    expect(sourced(installScript, 'printf "%s\\n" "${UNITS[@]}"').stdout).toContain("not-unreachable-allow-folder.service\n");
  });
});

describe("the update helper's verify unit", () => {
  const service = settings(updateUnit, "Service");

  it("runs the update helper's verify once per start, as root, and is never enabled", () => {
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/bin/node /usr/lib/not-unreachable/update-helper.mjs verify");
    expect(service.map(keyOf)).not.toContain("User");
    expect(updateUnit).not.toMatch(/^\[Install\]$/mu);
  });

  it("has no network, one capability, and writes only to its state folder, which install.sh makes", () => {
    expect(values(updateUnit, "Service", "CapabilityBoundingSet")).toEqual(["CAP_DAC_READ_SEARCH"]);
    expect(service).toContain("PrivateNetwork=yes");
    expect(service).toContain("IPAddressDeny=any");
    expect(service.map(keyOf)).not.toContain("IPAddressAllow");
    expect(values(updateUnit, "Service", "RestrictAddressFamilies")).toEqual(["AF_UNIX"]);
    expect(service).toContain("ProtectSystem=strict");
    expect(values(updateUnit, "Service", "ReadWritePaths")).toEqual([]);
    expect(`/var/lib/${values(updateUnit, "Service", "StateDirectory").join("")}`).toBe(installSetting("UPDATE_STATE_DIR"));
    expect(service).toContain("StateDirectoryMode=0755");
  });
});

describe("the update helper's apply unit", () => {
  const service = settings(updateApplyUnit, "Service");

  it("runs the update helper's apply once per start, as root, for up to an hour, and is never enabled", () => {
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/bin/node /usr/lib/not-unreachable/update-helper.mjs apply");
    // Past the helper's own limits added up (55 minutes), so systemd never kills it mid-rollback.
    expect(service).toContain("TimeoutStartSec=1h");
    expect(service.map(keyOf)).not.toContain("User");
    expect(updateApplyUnit).not.toMatch(/^\[Install\]$/mu);
  });

  it("writes what an upgrade writes and nothing else, and reaches loopback only", () => {
    expect(values(updateApplyUnit, "Service", "ReadWritePaths").toSorted()).toEqual(
      [
        "/opt/not-unreachable",
        "/usr/lib/not-unreachable",
        "/usr/local/bin",
        "/etc/systemd/system",
        "/etc/polkit-1/rules.d",
        "/usr/lib/sysusers.d",
        "/usr/lib/tmpfiles.d",
        "/srv/not-unreachable",
        "/run/not-unreachable-mount",
        "/var/lib/not-unreachable",
      ].toSorted(),
    );
    expect(service).toContain("ProtectSystem=strict");
    expect(`/var/lib/${values(updateApplyUnit, "Service", "StateDirectory").join("")}`).toBe(installSetting("UPDATE_STATE_DIR"));
    expect(service).toContain("IPAddressDeny=any");
    expect(values(updateApplyUnit, "Service", "IPAddressAllow")).toEqual(["localhost"]);
    expect(values(updateApplyUnit, "Service", "CapabilityBoundingSet").toSorted()).toEqual(
      ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH", "CAP_FOWNER"].toSorted(),
    );
  });
});

describe("install.sh's units", () => {
  it.each(["not-unreachable-allow-folder.service", "not-unreachable-update.service", "not-unreachable-update-apply.service"])(
    "include %s",
    (unit) => {
      expect(sourced(installScript, 'printf "%s\\n" "${UNITS[@]}"').stdout).toContain(`${unit}\n`);
    },
  );
});

describe("the CLI wrapper's sandbox for service-user commands", () => {
  it("is the service's [Service] settings, minus those that belong to the service alone", () => {
    const printed = sourced(cliWrapper, 'printf "%s\\n" "${SANDBOX_PROPERTIES[@]}"');
    expect(printed.status).toBe(0);
    const expected = settings(serviceUnit, "Service").filter((setting) => !SERVICE_ONLY.has(keyOf(setting)));
    expect(printed.stdout.trim().split("\n")).toEqual(expected);
  });
});

const systemdAnalyze = run("bash", ["-c", "command -v systemd-analyze"]).status === 0;

describe.skipIf(!systemdAnalyze)("systemd-analyze", () => {
  it("rates the service's exposure 2.0 or less", () => {
    const report = run("systemd-analyze", [
      "security",
      "--offline=true",
      "--no-pager",
      "--threshold=20",
      join(repoRoot, "deploy/systemd/not-unreachable.service"),
    ]);
    expect(report.stdout).toMatch(/Overall exposure level for not-unreachable\.service: (1\.\d|2\.0|0\.\d) /);
    expect(report.status).toBe(0);
  });

  it.each([
    ["not-unreachable-update.service", "HELPER", "1.5", /(0\.\d|1\.[0-5]) /],
    ["not-unreachable-update-apply.service", "APPLY", "3.0", /([0-2]\.\d|3\.0) /],
  ])("rates %s's exposure within install.sh's threshold for it", (unit, prefix, maximum, level) => {
    expect(installSetting(`${prefix}_MAX_EXPOSURE`)).toBe(maximum);
    const report = run("systemd-analyze", [
      "security",
      "--offline=true",
      "--no-pager",
      `--threshold=${installSetting(`${prefix}_SECURITY_THRESHOLD`)}`,
      join(repoRoot, "deploy/systemd", unit),
    ]);
    expect(report.stdout).toMatch(new RegExp(`Overall exposure level for ${unit.replaceAll(".", "\\.")}: ${level.source}`));
    expect(report.status).toBe(0);
  });

  it("rates the folder helper's exposure within install.sh's threshold for it, 1.5", () => {
    expect(installSetting("HELPER_MAX_EXPOSURE")).toBe("1.5");
    const report = run("systemd-analyze", [
      "security",
      "--offline=true",
      "--no-pager",
      `--threshold=${installSetting("HELPER_SECURITY_THRESHOLD")}`,
      join(repoRoot, "deploy/systemd/not-unreachable-allow-folder.service"),
    ]);
    expect(report.stdout).toMatch(/Overall exposure level for not-unreachable-allow-folder\.service: (0\.\d|1\.[0-5]) /);
    expect(report.status).toBe(0);
  });

  // verify also checks that ExecStart's program exists.
  it.skipIf(!existsSync("/usr/bin/node"))("finds nothing wrong in the units", () => {
    const verified = run("systemd-analyze", [
      "verify",
      "--man=no",
      ...[
        "not-unreachable.service",
        "not-unreachable-backup.service",
        "not-unreachable-backup.timer",
        "not-unreachable-allow-folder.service",
        "not-unreachable-update.service",
        "not-unreachable-update-apply.service",
      ].map((unit) => join(repoRoot, "deploy/systemd", unit)),
    ]);
    // A host without the service user or the release reports those; nothing else may come up.
    const problems = verified.stderr
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => !/not-unreachable(\/current)?'?: No such|User .*not-unreachable|WorkingDirectory/.test(line));
    expect(problems).toEqual([]);
  });
});
