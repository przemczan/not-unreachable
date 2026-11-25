import { describe, expect, it } from "vitest";
import { findRawStyleValues, foreignFontNames, noRawStyleValues } from "./no-raw-style-values.ts";
import { testRule } from "./rule-tester.ts";

describe("findRawStyleValues", () => {
  it.each([
    ["#fff", "#fff"],
    ["border: 1px solid #00aaff80", "1px"],
    ["rgb(0 0 0)", "rgb("],
    ["rgba(0,0,0,.5)", "rgba("],
    ["hsl(10 20% 30%)", "hsl("],
    ["oklch(0.7 0.1 30)", "oklch("],
    ["2em", "2em"],
    ["margin: -8px", "-8px"],
    ["1.5rem", "1.5rem"],
    ["100vh", "100vh"],
    ["12pt", "12pt"],
    ["font-family: Inter, sans-serif", "Inter"],
    ["font-['Comic_Sans_MS']", "Comic Sans MS"],
  ])("finds the raw value in %j", (text, value) => {
    expect(findRawStyleValues(text)).toContain(value);
  });

  it.each([
    "item",
    "system",
    "p-1.5",
    "max-w-95",
    "text-fg-1",
    "#section",
    "&#123;",
    "Page 2 of 5",
    "v1.2.3",
    "a3ex9",
    "font-family: Geist, sans-serif",
    'font-family: "Geist Mono", ui-monospace',
    "font-family: var(--font-sans)",
    "font-[600]",
  ])("finds nothing in %j", (text) => {
    expect(findRawStyleValues(text)).toEqual([]);
  });

  it("counts a unit right after a template expression", () => {
    expect(findRawStyleValues("px", true)).toEqual(["${…}px"]);
    expect(findRawStyleValues(" items", true)).toEqual([]);
    expect(findRawStyleValues("px", false)).toEqual([]);
  });

  it("lets only Geist and Geist Mono through as font names", () => {
    expect(foreignFontNames('"Geist", "Geist Mono", "Inter", monospace')).toEqual(["Inter"]);
  });
});

testRule("no-raw-style-values", noRawStyleValues, {
  valid: [
    `const tone = { fg: "var(--fg-1)" };`,
    `<div className="p-1.5 max-w-95 text-fg-1" />`,
    `import x from "./a-12px-file.ts"; export * from "./b-1em.ts";`,
    "const label = `${count} items`;",
    `const font = { fontFamily: "Geist Mono" };`,
    `const id = "system";`,
  ],
  invalid: [
    { code: `const tone = { fg: "#fff" };`, errors: ['"#fff"'] },
    { code: "const shadow = `0 ${px}px`;", errors: ['"${…}px"'] },
    { code: "const s = `margin: 8px ${a} 2rem`;", errors: ['"8px"', '"2rem"'] },
    { code: `const c = "rgb(0 0 0)";`, errors: ['"rgb("'] },
    { code: `const c = "oklch(0.7 0.1 30)";`, errors: ['"oklch("'] },
    { code: `<svg width="16px" />`, errors: ['"16px"'] },
    { code: `const font = { fontFamily: "Inter, sans-serif" };`, errors: ['"Inter"'] },
    { code: `const css = "font-family: 'Comic Sans MS'";`, errors: ['"Comic Sans MS"'] },
  ],
});
