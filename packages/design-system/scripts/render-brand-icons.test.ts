// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandIcons, brandSvgs, renderIcon } from "./render-brand-icons.ts";

const brand = new URL("../src/brand/", import.meta.url);

// The brand's static files are committed; these fail when mark.ts, the tokens or the name change
// without `pnpm brand-icons` run again.
describe("render-brand-icons", () => {
  it.each(brandSvgs().map(({ file, contents }) => [file, contents] as const))("generates the committed %s", (file, contents) => {
    expect(readFileSync(new URL(file, brand), "utf8")).toBe(contents);
  });

  it.each(brandIcons.map((icon) => [icon.output, icon] as const))("renders the committed %s", (_output, icon) => {
    expect(renderIcon(icon).equals(readFileSync(new URL(icon.output, brand)))).toBe(true);
  });
});
