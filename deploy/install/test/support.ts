import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const installScript = join(repoRoot, "deploy/install.sh");
export const cliWrapper = join(repoRoot, "deploy/bin/not-unreachable");
export const assembleScript = join(repoRoot, "scripts/release/assemble-bundle.sh");

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Run {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], ...options.env },
    input: options.input ?? "",
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a bash snippet with `script` sourced first (its `main` doesn't run when sourced). */
export function sourced(script: string, snippet: string, options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Run {
  // $0 is not the script, so its `main` guard (BASH_SOURCE[0] == $0) keeps it from running.
  return run("bash", ["-c", `set -euo pipefail; source "$1"; ${snippet}`, "test", script], options);
}

export function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

export function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "nu-install-test-"));
}

/** What deploy/mount-helper builds into dist/ and the bundle ships next to install.sh. */
export const HELPER_FILES = [
  "mount-helper.mjs",
  "request-file.mjs",
  "folder-access.mjs",
  "folder-helper.mjs",
  "update-helper.mjs",
  "release-verify.mjs",
  "release-archive.mjs",
] as const;

/** A release tarball's folder, as assemble-bundle.sh lays it out, with stand-ins for release/ and the helpers. */
export function makeBundle(version: string, arch = "x64"): string {
  const work = temporaryDirectory();
  const release = join(work, "release-source");
  mkdirSync(join(release, "dist"), { recursive: true });
  writeFileSync(join(release, "dist/main.js"), "// stand-in\n");
  writeFileSync(join(release, "dist/cli.js"), "// stand-in\n");
  const helpers = join(work, "helpers");
  mkdirSync(helpers);
  for (const file of HELPER_FILES) writeFileSync(join(helpers, file), "// stand-in\n");
  const bundle = join(work, `not-unreachable-${version}-linux-${arch}`);
  const assembled = run("bash", [assembleScript, release, helpers, version, arch, bundle]);
  if (assembled.status !== 0) throw new Error(`assemble-bundle.sh failed: ${assembled.stderr}`);
  return bundle;
}

/** One row of deploy/install.sh's layout (and of deployment.md's table): path, owner, mode, kind. */
export interface LayoutRow {
  readonly path: string;
  readonly owner: string;
  /** Octal, such as "755"; "-" for the symlink. */
  readonly mode: string;
  readonly kind: "d" | "f" | "l";
  readonly optional: boolean;
}

export function scriptLayout(version: string): LayoutRow[] {
  const printed = sourced(installScript, `VERSION=${version}; layout_rows`);
  if (printed.status !== 0) throw new Error(printed.stderr);
  return printed.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [path = "", owner = "", mode = "", kind = ""] = line.split(" ");
      const plainKind = kind.replace("?", "");
      if (!isLayoutKind(plainKind)) throw new Error(`layout_rows printed an unknown kind: ${line}`);
      return { path, owner, mode, kind: plainKind, optional: kind.endsWith("?") };
    });
}

function isLayoutKind(kind: string): kind is LayoutRow["kind"] {
  return kind === "d" || kind === "f" || kind === "l";
}
