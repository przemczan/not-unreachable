// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let outDir = "";
let html = "";

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "nu-web-build-"));
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
  html = await readFile(join(outDir, "index.html"), "utf8");
}, 120_000);

afterAll(async () => {
  if (outDir !== "") await rm(outDir, { recursive: true, force: true });
});

/** The CSP has no 'unsafe-inline' (threat model, T4), so the built page must hold no inline code. */
describe("the production build", () => {
  it("has only external scripts in index.html", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes = "", body = ""] of scripts) {
      expect(attributes).toMatch(/\ssrc=/i);
      expect(body.trim()).toBe("");
    }
  });

  it("has no style element or style attribute in index.html", () => {
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });

  it("has no inline event handlers or javascript: URLs in index.html", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("links its stylesheet as a file", () => {
    expect(html).toMatch(/<link\b[^>]*rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/i);
  });

  it("puts the admin interface in a chunk of its own", async () => {
    const assets = await readdir(join(outDir, "assets"));
    expect(assets.some((name) => /^admin-.*\.js$/.test(name))).toBe(true);
  });

  it("puts the public share page in a chunk of its own that loads nothing of the admin's", async () => {
    const assets = await readdir(join(outDir, "assets"));
    const share = assets.find((name) => /^share-.*\.js$/.test(name));
    expect(share).toBeDefined();
    const admin = assets.filter((name) => /^admin-.*\.js$/.test(name));

    // Every chunk the share page loads: its static imports and theirs. The entry's lazy imports of
    // the interfaces, `import("./admin-….js")`, load only on their own routes.
    const reached = new Set<string>();
    const pending = [share ?? ""];
    while (pending.length > 0) {
      const name = pending.pop() ?? "";
      if (reached.has(name)) continue;
      reached.add(name);
      const code = await readFile(join(outDir, "assets", name), "utf8");
      for (const [, imported = ""] of code.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) pending.push(imported);
    }
    expect([...reached].filter((name) => admin.includes(name))).toEqual([]);
    const code = (await Promise.all([...reached].map((name) => readFile(join(outDir, "assets", name), "utf8")))).join("\n");
    // Words only the admin's Share links screen and dialog, and the file browser, have.
    expect(code).not.toContain("Revoke link");
    expect(code).not.toContain("Create share link");
    expect(code).not.toContain("Upload files");
    expect(code).toContain("This link is not valid");
  });
});
