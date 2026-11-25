import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBrand, formatMatch } from "./check-brand.ts";

// Built at run time, so this file never holds the strings it looks for.
const word = (...parts: string[]) => parts.join("");
const NAME = word("Not", "Null", "Soft");
const SHORT = word("nn", "soft");
/** Each alternative of the pattern: the text written, and what the check reports as the match. */
const ALTERNATIVES: [string, string, string][] = [
  ["the company name", `${NAME}Admin`, NAME],
  ["the spaced name", word("not", " ", "null", " ", "soft"), word("not", " ", "null", " ", "soft")],
  ["the hyphenated name", word("Not", "-", "Null", "_", "Soft"), word("Not", "-", "Null", "_", "Soft")],
  ["the prefix", word("n", "ns", "-spin"), word("n", "ns", "-")],
  ["the snake prefix", word("N", "NS", "_TOKEN"), word("N", "NS", "_")],
  ["the short name", `${SHORT}.com`, SHORT],
];

const repositories: string[] = [];

/** A throwaway git repository with the given files (path → contents), all added to the index. */
function repository(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(tmpdir(), "check-brand-"));
  repositories.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  execFileSync("git", ["add", "--all"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of repositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("checkBrand", () => {
  it.each(ALTERNATIVES)("fails on %s in a file's contents", (_name, text, match) => {
    const root = repository({ "apps/web/src/a.ts": `export const ok = 1;\nconst label = "${text}";\n` });
    expect(checkBrand(root).map(formatMatch)).toEqual([`apps/web/src/a.ts:2: ${match}`]);
  });

  it.each(ALTERNATIVES)("fails on %s in a file's name", (_name, text, match) => {
    const file = `packages/design-system/src/${text}.svg`;
    const root = repository({ [file]: "<svg />\n" });
    expect(checkBrand(root).map(formatMatch)).toEqual([`${file}: file name matches "${match}"`]);
  });

  it("checks deploy/ too, and files git doesn't track yet", () => {
    const root = repository({});
    mkdirSync(path.join(root, "deploy"));
    writeFileSync(path.join(root, "deploy", "compose.yml"), `image: ${SHORT}\n`);
    expect(checkBrand(root).map((match) => match.path)).toEqual(["deploy/compose.yml"]);
  });

  it("passes on Drizzle's .notNull() and outside apps/, packages/ and deploy/", () => {
    const root = repository({
      "apps/server/src/schema.ts": 'export const name = text("name").notNull();\nconst dnns_x = 1; // no word boundary before the prefix\n',
      "docs/design/source.md": `The source is ${NAME}.\n`,
    });
    expect(checkBrand(root)).toEqual([]);
  });

  it("skips a binary file's contents but still checks its name", () => {
    const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(NAME)]);
    const root = repository({ "packages/design-system/src/brand/logo.png": binary, [`apps/web/public/${SHORT}.png`]: binary });
    expect(checkBrand(root).map(formatMatch)).toEqual([`apps/web/public/${SHORT}.png: file name matches "${SHORT}"`]);
  });
});
