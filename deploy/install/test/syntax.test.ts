import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, run } from "./support.ts";

const scripts = [
  "deploy/install.sh",
  "deploy/bin/not-unreachable",
  "deploy/test/propagation.sh",
  "deploy/test/selinux-vm.sh",
  "deploy/test/systemd-container.sh",
  "scripts/release/assemble-bundle.sh",
  "scripts/release/bootstrap-install.sh",
  "scripts/release/build-tarball.sh",
];

const shellcheckInstalled = run("bash", ["-c", "command -v shellcheck"]).status === 0;

describe("the shell scripts", () => {
  it.each(scripts)("%s parses (bash -n)", (script) => {
    const checked = run("bash", ["-n", join(repoRoot, script)]);
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  });

  it.skipIf(!shellcheckInstalled).each(scripts)("%s passes shellcheck", (script) => {
    const checked = run("shellcheck", ["--shell=bash", "--severity=style", join(repoRoot, script)]);
    expect(checked.stdout).toBe("");
    expect(checked.status).toBe(0);
  });
});
