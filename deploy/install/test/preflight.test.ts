import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installScript, sourced, temporaryDirectory } from "./support.ts";

function osRelease(id: string, versionId: string): string {
  const file = join(temporaryDirectory(), "os-release");
  writeFileSync(file, `ID=${id}\nVERSION_ID="${versionId}"\nPRETTY_NAME="${id} ${versionId}"\n`);
  return file;
}

function check(snippet: string) {
  return sourced(installScript, snippet);
}

describe("the preflight checks", () => {
  it.each([
    ["debian", "12", "apt"],
    ["debian", "13", "apt"],
    ["ubuntu", "24.04", "apt"],
    ["ubuntu", "26.04", "apt"],
    ["fedora", "40", "dnf"],
    ["fedora", "43", "dnf"],
    ["rhel", "9.4", "dnf"],
    ["almalinux", "9.6", "dnf"],
    ["rocky", "10.0", "dnf"],
  ])("accepts %s %s and installs with %s", (id, version, manager) => {
    const checked = check(`check_distribution ${osRelease(id, version)}`);
    expect(checked.stderr).toBe("");
    expect(checked.stdout).toBe(manager);
  });

  it.each([
    ["debian", "11"],
    ["ubuntu", "22.04"],
    ["fedora", "39"],
    ["rhel", "8.10"],
    ["alpine", "3.22.1"],
    ["arch", ""],
    ["opensuse-leap", "15.6"],
  ])("refuses %s %s", (id, version) => {
    const checked = check(`check_distribution ${osRelease(id, version)}`);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toMatch(/not supported|too old/);
  });

  it("accepts systemd 252 and newer, and refuses older", () => {
    expect(check(`check_systemd_version "systemd 252 (252.30-1~deb12u2)"`).status).toBe(0);
    expect(check(`check_systemd_version "systemd 255 (255.4-1ubuntu8)"`).status).toBe(0);
    const old = check(`check_systemd_version "systemd 249 (249.11-0ubuntu3)"`);
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("systemd 249 is too old");
  });

  it("accepts glibc and refuses musl", () => {
    expect(check(`check_libc "glibc 2.36"`).status).toBe(0);
    // `getconf GNU_LIBC_VERSION` answers nothing on musl.
    const musl = check(`check_libc ""`);
    expect(musl.status).toBe(1);
    expect(musl.stderr).toContain("musl is not supported");
  });

  it("accepts a tarball for the host's architecture and refuses another", () => {
    expect(check("check_arch x86_64 x64").status).toBe(0);
    expect(check("check_arch aarch64 arm64").status).toBe(0);
    const wrong = check("check_arch aarch64 x64");
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("linux-arm64.tar.gz");
    expect(check("check_arch riscv64 x64").stderr).toContain("not supported");
  });

  it("uses Node 24.11 or newer, installs it when there is none, and refuses any other major", () => {
    expect(check("check_node v24.11.0").status).toBe(0);
    expect(check("check_node v24.22.3").status).toBe(0);
    expect(check('check_node ""').status).toBe(1);
    expect(check('check_node ""').stderr).toBe("");
    for (const other of ["v22.12.0", "v23.11.0", "v25.1.0", "v20.19.0"]) {
      const refused = check(`check_node ${other}`);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("won't replace another major");
    }
    expect(check("check_node v24.10.0").stderr).toContain("24.11 or newer");
  });

  it("takes only an https origin for PUBLIC_ORIGIN", () => {
    for (const good of ["https://files.example.com", "https://files.example.com:8443", "https://nas"]) {
      expect(check(`valid_public_origin ${good}`).status, good).toBe(0);
    }
    for (const bad of [
      "http://files.example.com",
      "https://files.example.com/",
      "https://x.example.com/path",
      "files.example.com",
      "https://",
    ]) {
      expect(check(`valid_public_origin '${bad}'`).status, bad).toBe(1);
    }
  });
});
