// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadTokenSource, resolveValue } from "./token-source.ts";

const source = loadTokenSource();

/** The sRGB channels of a #rgb or #rrggbb colour, 0–255; anything else fails the test clearly. */
function channels(name: string, value: string): [number, number, number] {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  const hex = short === null ? long?.slice(1, 4) : short.slice(1, 4).map((digit) => digit + digit);
  if (hex === undefined) throw new Error(`The token "${name}" resolves to ${value}: the contrast test reads only opaque hex colours.`);
  const [r, g, b] = hex.map((pair) => Number.parseInt(pair, 16));
  return [r ?? 0, g ?? 0, b ?? 0];
}

/** WCAG 2.x relative luminance. */
function luminance(name: string, value: string): number {
  const [r, g, b] = channels(name, value).map((channel) => {
    const c = channel / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(first: string, second: string, theme: "light" | "dark"): number {
  const a = luminance(first, resolveValue(source, first, theme));
  const b = luminance(second, resolveValue(source, second, theme));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const pairs = [
  { foreground: "fg-on-accent", background: "accent-fill", minimum: 4.5 },
  { foreground: "fg-on-accent", background: "accent-fill-hover", minimum: 4.5 },
  { foreground: "border-control", background: "surface", minimum: 3 },
  // The logo's mark (WCAG 1.4.11, graphics): on the page, on the sidebar and on its own square.
  { foreground: "accent", background: "bg", minimum: 3 },
  { foreground: "accent", background: "sidebar-bg", minimum: 3 },
  { foreground: "accent", background: "surface-sunken", minimum: 3 },
] as const;

describe("token contrast (WCAG)", () => {
  for (const theme of ["light", "dark"] as const) {
    it.each(pairs)(`${theme}: $foreground on $background is at least $minimum:1`, ({ foreground, background, minimum }) => {
      expect(contrast(foreground, background, theme)).toBeGreaterThanOrEqual(minimum);
    });
  }

  it("computes the reference ratios", () => {
    expect(luminance("white", "#fff")).toBeCloseTo(1);
    expect(luminance("black", "#000000")).toBe(0);
    expect(() => luminance("oklch", "oklch(0.5 0.1 30)")).toThrow(/only opaque hex/);
  });
});
