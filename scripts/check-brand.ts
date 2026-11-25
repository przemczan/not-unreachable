/**
 * Fails when the source brand is left anywhere in apps/, packages/ or deploy/: in a file's contents
 * or in its path (docs/design/design-system.md, "Check that nothing is left"). docs/design/ is not
 * checked, as it has to name the source. The pattern is deliberately not just "notnull", which
 * would hit Drizzle's `.notNull()`.
 *
 * Usage: node scripts/check-brand.ts [repository root]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const BRAND_PATTERN = /notnullsoft|not[-_ ]null[-_ ]soft|\bnns[-_]|nnsoft/i;
export const CHECKED_DIRECTORIES = ["apps", "packages", "deploy"] as const;

export interface BrandMatch {
  /** The file's path from the repository's root. */
  readonly path: string;
  /** The 1-based line of the match in the file's contents; null when the match is in the path. */
  readonly line: number | null;
  readonly match: string;
}

/** The matches in a file's path and, unless it is binary (holds a NUL byte), in its contents. */
export function findBrandMatches(filePath: string, contents: Buffer | null): BrandMatch[] {
  const matches: BrandMatch[] = [];
  const inPath = BRAND_PATTERN.exec(filePath);
  if (inPath !== null) {
    matches.push({ path: filePath, line: null, match: inPath[0] });
  }
  if (contents !== null && !contents.includes(0)) {
    contents
      .toString("utf8")
      .split(/\r?\n/)
      .forEach((text, index) => {
        const inLine = BRAND_PATTERN.exec(text);
        if (inLine !== null) {
          matches.push({ path: filePath, line: index + 1, match: inLine[0] });
        }
      });
  }
  return matches;
}

/** The files git knows under the checked directories: tracked ones, and new ones it doesn't ignore. */
export function listFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...CHECKED_DIRECTORIES], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter((file) => file !== ""))];
}

function readIfPresent(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    // A tracked file deleted in the working tree has nothing left to check but its name.
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR")) {
      return null;
    }
    throw error;
  }
}

export function checkBrand(root: string): BrandMatch[] {
  return listFiles(root).flatMap((file) => findBrandMatches(file, readIfPresent(path.join(root, file))));
}

export function formatMatch(match: BrandMatch): string {
  return match.line === null ? `${match.path}: file name matches "${match.match}"` : `${match.path}:${match.line}: ${match.match}`;
}

function main(): void {
  const root = path.resolve(process.argv[2] ?? ".");
  const matches = checkBrand(root);
  if (matches.length > 0) {
    console.error(matches.map(formatMatch).join("\n"));
    console.error(
      `\nThe source brand is left in ${CHECKED_DIRECTORIES.join("/, ")}/ (docs/design/design-system.md, "Check that nothing is left").`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
