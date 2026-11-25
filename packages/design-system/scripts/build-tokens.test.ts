// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exposures, outputs, renderThemeCss, staleOutputs } from "./build-tokens.ts";
import { exposureOf, type Exposure } from "./theme-mapping.ts";
import { allTokens, loadTokenSource, typeStyles } from "./token-source.ts";

const source = loadTokenSource();
const tokensCss = readFileSync(fileURLToPath(new URL("../src/tokens.css", import.meta.url)), "utf8");

/**
 * The source design system's documented token list (its adherence lint config), as CSS variables.
 * `--font-logo` is left out: it is removed with the source wordmark, whose display face this
 * product doesn't ship.
 */
const DOCUMENTED_TOKENS = [
  "--accent",
  "--accent-hover",
  "--accent-press",
  "--accent-subtle",
  "--accent-subtle-fg",
  "--amber-100",
  "--amber-50",
  "--amber-500",
  "--amber-600",
  "--amber-700",
  "--bg",
  "--blue-100",
  "--blue-50",
  "--blue-500",
  "--blue-600",
  "--blue-700",
  "--border",
  "--border-focus",
  "--border-strong",
  "--border-subtle",
  "--border-width",
  "--card-padding",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-axis",
  "--chart-grid",
  "--chart-track",
  "--content-max",
  "--control-hover",
  "--control-lg",
  "--control-md",
  "--control-press",
  "--control-sm",
  "--control-xs",
  "--danger",
  "--danger-border",
  "--danger-fg",
  "--danger-hover",
  "--danger-press",
  "--danger-subtle",
  "--duration-base",
  "--duration-fast",
  "--duration-instant",
  "--duration-slow",
  "--ease-in-out",
  "--ease-out",
  "--ember-100",
  "--ember-200",
  "--ember-300",
  "--ember-400",
  "--ember-50",
  "--ember-500",
  "--ember-600",
  "--ember-700",
  "--ember-800",
  "--ember-900",
  "--fg-1",
  "--fg-2",
  "--fg-3",
  "--fg-disabled",
  "--fg-inverse",
  "--fg-on-accent",
  "--flare-100",
  "--flare-300",
  "--flare-500",
  "--flare-700",
  "--focus-ring",
  "--font-mono",
  "--font-sans",
  "--gray-100",
  "--gray-150",
  "--gray-200",
  "--gray-25",
  "--gray-300",
  "--gray-400",
  "--gray-50",
  "--gray-500",
  "--gray-600",
  "--gray-700",
  "--gray-800",
  "--gray-900",
  "--gray-950",
  "--green-100",
  "--green-50",
  "--green-500",
  "--green-600",
  "--green-700",
  "--info",
  "--info-border",
  "--info-fg",
  "--info-subtle",
  "--leading-normal",
  "--leading-snug",
  "--leading-tight",
  "--negative",
  "--neutral-border",
  "--neutral-fg",
  "--neutral-subtle",
  "--overlay",
  "--page-padding",
  "--positive",
  "--primary",
  "--primary-fg",
  "--primary-hover",
  "--primary-press",
  "--radius-0",
  "--radius-badge",
  "--radius-card",
  "--radius-control",
  "--radius-dialog",
  "--radius-full",
  "--radius-lg",
  "--radius-md",
  "--radius-sm",
  "--radius-xl",
  "--radius-xs",
  "--red-100",
  "--red-50",
  "--red-500",
  "--red-600",
  "--red-700",
  "--row-compact",
  "--row-default",
  "--row-relaxed",
  "--shadow-0",
  "--shadow-1",
  "--shadow-2",
  "--shadow-3",
  "--sidebar-active-bg",
  "--sidebar-active-fg",
  "--sidebar-bg",
  "--sidebar-collapsed",
  "--sidebar-fg",
  "--sidebar-width",
  "--space-0",
  "--space-0-5",
  "--space-1",
  "--space-1-5",
  "--space-10",
  "--space-12",
  "--space-16",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-8",
  "--space-px",
  "--success",
  "--success-border",
  "--success-fg",
  "--success-subtle",
  "--surface",
  "--surface-hover",
  "--surface-inverse",
  "--surface-raised",
  "--surface-selected",
  "--surface-sunken",
  "--teal-500",
  "--text-2xl",
  "--text-2xs",
  "--text-3xl",
  "--text-4xl",
  "--text-5xl",
  "--text-lg",
  "--text-link",
  "--text-link-hover",
  "--text-md",
  "--text-sm",
  "--text-xl",
  "--text-xs",
  "--topbar-height",
  "--tracking-caps",
  "--tracking-normal",
  "--tracking-tight",
  "--type-body",
  "--type-body-sm",
  "--type-caption",
  "--type-card-title",
  "--type-label",
  "--type-metric",
  "--type-metric-sm",
  "--type-mono",
  "--type-overline",
  "--type-page-title",
  "--type-section-title",
  "--violet-500",
  "--warning",
  "--warning-border",
  "--warning-fg",
  "--warning-subtle",
  "--weight-medium",
  "--weight-regular",
  "--weight-semibold",
  "--white",
  "--z-base",
  "--z-drawer",
  "--z-dropdown",
  "--z-modal",
  "--z-sticky",
  "--z-toast",
  "--z-tooltip",
] as const;

/** A theme variable or utility with a valid name, or not exposed with a reason. */
function isMapped(exposure: Exposure): boolean {
  if (exposure.kind === "theme") return /^--[a-z0-9-]+$/.test(exposure.variable);
  if (exposure.kind === "utility") return /^[a-z0-9-]+$/.test(exposure.utility) && exposure.property !== "";
  return exposure.reason.trim() !== "";
}

/** Reads the repository's files, with one change in tokens.css: a renamed variable. */
function drifted(path: string): string {
  const text = readFileSync(path, "utf8");
  return path.endsWith("tokens.css") ? text.replace("--accent:", "--accent-drifted:") : text;
}

async function generatedThemeCss(): Promise<string> {
  const theme = (await outputs(source)).find((output) => output.path.endsWith("theme.css"));
  if (theme === undefined) throw new Error("The generator has no theme.css output.");
  return theme.expected;
}

describe("build-tokens", () => {
  it("generates the committed theme.css", async () => {
    await expect(await generatedThemeCss()).toMatchFileSnapshot("__snapshots__/theme.css.snap");
  });

  it("maps every source token, or says why it isn't exposed", () => {
    const mapped = exposures(source);
    expect(mapped.map(({ token }) => token.name).toSorted()).toEqual(
      allTokens(source)
        .map((token) => token.name)
        .toSorted(),
    );
    const unmapped = mapped.filter(({ exposure }) => !isMapped(exposure)).map(({ token }) => token.name);
    expect(unmapped).toEqual([]);
  });

  it("refuses a token no mapping covers", () => {
    expect(() => exposureOf("fontWeight", { name: "weight-black", value: "900", usage: "Not a real token." })).toThrow(/weight-black/);
  });

  it("defines every token of the source design system's documented list in tokens.css", () => {
    const defined = new Set(Array.from(tokensCss.matchAll(/^\s*(--[a-z0-9-]+):/gm), (match) => match[1]));
    const missing = DOCUMENTED_TOKENS.filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it("--check passes on the repository's files", async () => {
    expect(await staleOutputs()).toEqual([]);
  });

  it("--check fails when a generated file drifts", async () => {
    const stale = await staleOutputs(undefined, drifted);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/src[\\/]tokens\.css$/);
  });

  it("writes the dark variant, the type utilities and the spinner, and nothing of the source brand", () => {
    const css = renderThemeCss(source);
    expect(css).toContain("@custom-variant dark");
    for (const style of typeStyles(source)) expect(css).toContain(`@utility type-${style.name} {`);
    expect(css).toContain("@keyframes nu-spin");
    // Spelled in two parts so the repository's brand check doesn't flag this test itself.
    expect(css).not.toContain(["nn", "s-"].join(""));
  });
});
