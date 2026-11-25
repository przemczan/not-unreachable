import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(path.join(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");

/** Each job's text under `jobs:`, by its name (the lines indented by two spaces start one). */
function jobs(): Map<string, string> {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const found = new Map<string, string>();
  let name: string | undefined;
  for (const line of body.split("\n")) {
    const header = /^ {2}([a-z][a-z0-9-]*):$/.exec(line);
    if (header !== null) {
      name = header[1];
      if (name !== undefined) found.set(name, "");
    } else if (name !== undefined && !line.trimStart().startsWith("#")) {
      found.set(name, `${found.get(name) ?? ""}${line}\n`);
    }
  }
  return found;
}

describe("the Release workflow (threat model, T17)", () => {
  const all = jobs();
  const sign = all.get("sign") ?? "";
  const publish = all.get("publish") ?? "";

  it("signs between the builds and the publishing, and never on a dry run", () => {
    expect(sign).toContain("needs: [version, build]");
    expect(sign).toContain("if: needs.version.outputs.tag != ''");
    expect(publish).toMatch(/needs: \[[^\]]*\bsign\b[^\]]*\]/);
  });

  it("gives only the sign job the release-signing environment and its secrets", () => {
    for (const [name, text] of all) {
      if (name === "sign") continue;
      expect(text, name).not.toMatch(/environment:/);
      expect(text, name).not.toMatch(/secrets\./);
    }
    expect(sign).toContain("environment: release-signing");
    expect(sign).toContain("RELEASE_SIGNING_KEY: ${{ secrets.RELEASE_SIGNING_KEY }}");
    expect(sign).toContain("permissions:\n      contents: read\n");
    expect(sign).not.toContain("contents: write");
  });

  it("references the sign job's Actions by commit SHA", () => {
    const uses = [...sign.matchAll(/uses: (\S+)/g)].map((match) => match[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("signs SHA256SUMS over the tarballs and the one-line installer, and publishes both files", () => {
    expect(sign).toContain("sha256sum -- *.tar.gz install.sh > SHA256SUMS");
    expect(sign).toContain("node scripts/release/sign-checksums.ts out");
    expect(publish).toContain("sha256sum --check --strict SHA256SUMS");
    expect(publish).toContain("out/SHA256SUMS out/SHA256SUMS.sig");
  });
});
