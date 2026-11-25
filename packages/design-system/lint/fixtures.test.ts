import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oxlintBin = path.join(path.dirname(createRequire(import.meta.url).resolve("oxlint/package.json")), "bin", "oxlint");

interface Diagnostic {
  readonly code: string;
  readonly message: string;
}

/** Lints the fixture with the adherence config alone, as oxlint's JSON report. */
async function lintFixture(): Promise<Diagnostic[]> {
  const args = [oxlintBin, "-c", "lint/adherence.oxlintrc.json", "--format", "json", "lint/fixtures/bad-screen.tsx"];
  const result = await promisify(execFile)(process.execPath, args, { cwd: packageDir }).catch((error: unknown) => {
    // oxlint exits 1 when it finds errors, which is what this fixture is for.
    if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
      return { stdout: error.stdout };
    }
    throw error;
  });
  const report: unknown = JSON.parse(result.stdout);
  if (typeof report !== "object" || report === null || !("diagnostics" in report) || !Array.isArray(report.diagnostics)) {
    throw new Error(`oxlint printed no JSON report:\n${result.stdout}`);
  }
  return report.diagnostics.filter(isDiagnostic);
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

describe("lint/fixtures/bad-screen.tsx under adherence.oxlintrc.json", () => {
  let diagnostics: Diagnostic[] = [];
  beforeAll(async () => {
    diagnostics = await lintFixture();
  }, 60_000);

  it.each([
    "nu-design-system(no-arbitrary-values)",
    "nu-design-system(no-raw-style-values)",
    "nu-design-system(no-inline-style)",
    "nu-design-system(no-style-element)",
    "nu-design-system(no-unknown-classes)",
    "react(no-danger)",
    "eslint(no-restricted-globals)",
  ])("trips %s", (code) => {
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  it.each([
    ["internals", "@not-unreachable/design-system/src/components/button/Button.tsx"],
    ["other kits", "react-icons/fa"],
    ["CSS", "./file-list.css"],
  ])("trips no-restricted-imports: %s", (_group, specifier) => {
    const restricted = diagnostics.filter((diagnostic) => diagnostic.code === "eslint(no-restricted-imports)");
    expect(restricted.map((diagnostic) => diagnostic.message)).toContainEqual(expect.stringContaining(`'${specifier}'`));
  });
});
