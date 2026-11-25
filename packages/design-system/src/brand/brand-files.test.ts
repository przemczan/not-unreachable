import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { faviconCut, markCut } from "./mark.ts";

// A path, not a URL: under jsdom the global URL is jsdom's, which node:fs doesn't take.
const brand = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(brand);
const svgs = files.filter((file) => file.endsWith(".svg"));

function read(file: string): string {
  return readFileSync(join(brand, file), "utf8");
}

function parse(file: string): Document {
  return new DOMParser().parseFromString(read(file), "image/svg+xml");
}

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(file: string): [number, number] {
  const bytes = readFileSync(join(brand, file));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("brand files", () => {
  it("has the mark, the lockups, the favicon and the app icons", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "logo-mark.svg",
        "logo-mark-dark.svg",
        "logo-mark-mono.svg",
        "logo-lockup.svg",
        "logo-lockup-dark.svg",
        "favicon.svg",
        "apple-touch-icon.png",
        "icon-512.png",
      ]),
    );
  });

  it.each(files.filter((file) => !file.endsWith(".png") && !file.includes(".test.")))("%s has no placeholder left", (file) => {
    expect(read(file)).not.toMatch(/placeholder/i);
  });

  it.each(svgs)("%s is a self-contained SVG with a viewBox", (file) => {
    const document = parse(file);
    const root = document.documentElement;

    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(root.localName).toBe("svg");
    expect(root.getAttribute("viewBox")).toMatch(/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/);
    expect(document.getElementsByTagName("script")).toHaveLength(0);
    const attributes = [...document.querySelectorAll("*")].flatMap((element) => [...element.attributes]);
    expect(attributes.filter(({ name }) => /^on/i.test(name))).toEqual([]);
    expect(attributes.filter(({ name, value }) => /(^|:)href$/.test(name) && !value.startsWith("#"))).toEqual([]);
    expect(read(file)).not.toMatch(/url\((?!#)|@import/);
  });

  it.each(["logo-mark.svg", "logo-mark-dark.svg", "logo-mark-mono.svg", "logo-lockup.svg", "logo-lockup-dark.svg"])(
    "%s draws the mark from mark.ts",
    (file) => {
      expect(parse(file).querySelector("path")?.getAttribute("d")).toBe(markCut.route);
    },
  );

  it("favicon.svg draws the favicon's cut of the mark, light and dark", () => {
    expect(parse("favicon.svg").querySelector("path")?.getAttribute("d")).toBe(faviconCut.route);
    expect(read("favicon.svg")).toContain("@media (prefers-color-scheme: dark)");
  });

  it.each(["logo-lockup.svg", "logo-lockup-dark.svg"])("%s has the name outlined, with no text", (file) => {
    const document = parse(file);

    expect(document.getElementsByTagName("text")).toHaveLength(0);
    expect(document.querySelectorAll("path")).toHaveLength(2);
  });

  it.each([
    ["apple-touch-icon.png", 180],
    ["icon-512.png", 512],
  ] as const)("%s is %ipx square", (file, size) => {
    expect(pngSize(file)).toEqual([size, size]);
  });
});
