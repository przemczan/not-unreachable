/**
 * Writes the brand's static files in src/brand from the mark's drawing (src/brand/mark.ts), the
 * tokens and Geist: the mark in light, dark and one colour, the favicon, the lockups with the name
 * outlined from Geist, for use outside the app, and the PNG icons for the places that take no SVG.
 * The files are committed; run this again whenever the mark, its tokens or the name change.
 *
 *   node scripts/render-brand-icons.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { create, type Font, type Path } from "fontkit";
import { MARK_CORNER_RADIUS, MARK_VIEW_BOX, faviconCut, markCut, type MarkCut } from "../src/brand/mark.ts";
import { PRODUCT_NAME } from "../src/brand/product-name.ts";
import { loadTokenSource, resolveValue } from "./token-source.ts";

const brand = new URL("../src/brand/", import.meta.url);
const geist = new URL("../src/fonts/Geist-Variable.woff2", import.meta.url);

type Theme = "light" | "dark";

/** The colours the brand reads from the tokens, in one theme. */
interface BrandColours {
  readonly square: string;
  readonly accent: string;
  readonly text: string;
}

export function brandColours(theme: Theme): BrandColours {
  const source = loadTokenSource();
  return {
    square: resolveValue(source, "surface-sunken", theme),
    accent: resolveValue(source, "accent", theme),
    text: resolveValue(source, "fg-1", theme),
  };
}

/** How the route and the node are painted: presentation attributes, or classes a `<style>` paints. */
interface MarkPaint {
  readonly route: string;
  readonly node: string;
}

function colourPaint(colour: string): MarkPaint {
  return { route: `stroke="${colour}"`, node: `fill="${colour}"` };
}

function squareElement(paint: string): string {
  return `<rect width="32" height="32" rx="${MARK_CORNER_RADIUS}" ${paint} />`;
}

function markElements(cut: MarkCut, paint: MarkPaint): string[] {
  const { route, routeWidth, node } = cut;
  return [
    `<path d="${route}" fill="none" ${paint.route} stroke-width="${routeWidth}" stroke-linecap="round" stroke-linejoin="round" />`,
    `<circle cx="${node.cx}" cy="${node.cy}" r="${node.r}" ${paint.node} />`,
  ];
}

function svgDocument(viewBox: string, body: readonly string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${PRODUCT_NAME}">`,
    ...body.map((line) => `  ${line}`),
    "</svg>",
    "",
  ].join("\n");
}

function markSvg(colours: BrandColours): string {
  return svgDocument(MARK_VIEW_BOX, [squareElement(`fill="${colours.square}"`), ...markElements(markCut, colourPaint(colours.accent))]);
}

/** The favicon follows the browser's colour scheme, since a favicon can't read the page's theme. */
function faviconSvg(light: BrandColours, dark: BrandColours): string {
  const rules = (colours: BrandColours): string[] => [
    `.square { fill: ${colours.square}; }`,
    `.route { stroke: ${colours.accent}; }`,
    `.node { fill: ${colours.accent}; }`,
  ];
  return svgDocument(MARK_VIEW_BOX, [
    "<style>",
    ...rules(light).map((rule) => `  ${rule}`),
    "  @media (prefers-color-scheme: dark) {",
    ...rules(dark).map((rule) => `    ${rule}`),
    "  }",
    "</style>",
    squareElement('class="square"'),
    ...markElements(faviconCut, { route: 'class="route"', node: 'class="node"' }),
  ]);
}

/** The lockup's proportions, as `<Logo />` draws them at its default size: a 24px mark, 8px apart from an 18px name. */
const WORDMARK_SCALE = 18 / 24;
const LOCKUP_GAP = 8 / 24;
/** tracking-tight. */
const TRACKING_EM = -0.025;
/** font-semibold. */
const WORDMARK_WEIGHT = 600;

function loadGeist(): Font {
  const loaded = create(readFileSync(geist));
  if ("fonts" in loaded) throw new Error(`${fileURLToPath(geist)} is a font collection; expected one font.`);
  return loaded.getVariation({ wght: WORDMARK_WEIGHT });
}

const pathLetters = { moveTo: "M", lineTo: "L", quadraticCurveTo: "Q", bezierCurveTo: "C", closePath: "Z" } as const;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A glyph's outline as path data, its font units placed with `place`. */
function outlineData(path: Path, place: (x: number, y: number) => [number, number]): string {
  return path.commands
    .map(({ command, args }) => {
      const points: number[] = [];
      for (let index = 0; index + 1 < args.length; index += 2) points.push(...place(args[index] ?? 0, args[index + 1] ?? 0).map(round));
      return pathLetters[command] + points.join(" ");
    })
    .join("");
}

/** The name outlined in Geist semibold with tight tracking, its baseline at `baseline`, from `left`. */
function outlineName(font: Font, size: number, left: number, baseline: number): { data: string; width: number } {
  const scale = size / font.unitsPerEm;
  const tracking = TRACKING_EM * font.unitsPerEm;
  const run = font.layout(PRODUCT_NAME);
  let pen = 0;
  const outlines = run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const originX = pen + (position?.xOffset ?? 0);
    const originY = position?.yOffset ?? 0;
    pen += (position?.xAdvance ?? glyph.advanceWidth) + tracking;
    return outlineData(glyph.path, (x, y) => [left + (originX + x) * scale, baseline - (originY + y) * scale]);
  });
  return { data: outlines.join(""), width: (pen - tracking) * scale };
}

function lockupSvg(font: Font, colours: BrandColours): string {
  const markSize = 32;
  const size = markSize * WORDMARK_SCALE;
  const left = markSize + markSize * LOCKUP_GAP;
  // As in the browser with line-height 1: the name's ascent-to-descent box is centred on the mark.
  const baseline = markSize / 2 + ((font.ascent + font.descent) / 2) * (size / font.unitsPerEm);
  const name = outlineName(font, size, left, baseline);
  return svgDocument(`0 0 ${round(left + name.width)} ${markSize}`, [
    squareElement(`fill="${colours.square}"`),
    ...markElements(markCut, colourPaint(colours.accent)),
    `<path d="${name.data}" fill="${colours.text}" />`,
  ]);
}

export interface BrandFile {
  /** Its name in src/brand. */
  readonly file: string;
  readonly contents: string;
}

/** The brand's SVG files, as this script writes them. */
export function brandSvgs(): BrandFile[] {
  const light = brandColours("light");
  const dark = brandColours("dark");
  const font = loadGeist();
  return [
    { file: "logo-mark.svg", contents: markSvg(light) },
    { file: "logo-mark-dark.svg", contents: markSvg(dark) },
    { file: "logo-mark-mono.svg", contents: svgDocument(MARK_VIEW_BOX, markElements(markCut, colourPaint("currentColor"))) },
    { file: "favicon.svg", contents: faviconSvg(light, dark) },
    { file: "logo-lockup.svg", contents: lockupSvg(font, light) },
    { file: "logo-lockup-dark.svg", contents: lockupSvg(font, dark) },
  ];
}

export interface BrandIcon {
  /** The SVG it is drawn from, in src/brand. */
  readonly source: string;
  /** The PNG it writes, in src/brand. */
  readonly output: string;
  /** Width and height, in px. */
  readonly size: number;
}

/**
 * Each fills the whole square behind the drawing with the mark's square colour: iOS rounds the
 * corners itself and shows transparent corners as black, and launchers mask the 512px icon.
 */
export const brandIcons: readonly BrandIcon[] = [
  { source: "logo-mark.svg", output: "apple-touch-icon.png", size: 180 },
  { source: "logo-mark.svg", output: "icon-512.png", size: 512 },
];

/** Draws one icon as PNG bytes. */
export function renderIcon(icon: BrandIcon, directory: URL = brand): Buffer {
  const svg = readFileSync(new URL(icon.source, directory), "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: icon.size }, background: brandColours("light").square });
  return resvg.render().asPng();
}

function write(file: string, contents: string | Buffer): void {
  const target = new URL(file, brand);
  writeFileSync(target, contents);
  console.log(`wrote ${fileURLToPath(target)}`);
}

function main(): void {
  for (const { file, contents } of brandSvgs()) write(file, contents);
  for (const icon of brandIcons) write(icon.output, renderIcon(icon));
}

if (import.meta.main) {
  main();
}
