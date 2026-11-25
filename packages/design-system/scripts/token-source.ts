import { readFileSync } from "node:fs";

/** A value that differs per theme, or one value for both. */
export type TokenValue = string | { readonly light: string; readonly dark: string };

export interface Token {
  readonly name: string;
  readonly value: TokenValue;
  readonly usage: string;
}

export interface TypeStyle {
  readonly name: string;
  readonly fontSize: string;
  readonly lineHeight: number;
  readonly fontWeight: number;
  readonly letterSpacing?: string;
  readonly usage: string;
  readonly sample: string;
}

export interface FontFile {
  readonly family: string;
  readonly file: string;
  readonly weight: string;
  readonly style: string;
}

export type FamilyKey = "sans" | "mono";

export interface TypeGroup {
  readonly name: string;
  readonly family: FamilyKey;
  readonly styles: readonly TypeStyle[];
}

interface TokenGroup {
  readonly tokens: readonly Token[];
}

/** The shape of `tokens/tokens.json`. */
export interface TokenSource {
  readonly name: string;
  readonly version: number;
  readonly color: TokenGroup & { readonly themes: readonly { readonly id: string; readonly name: string }[] };
  readonly type: {
    readonly fonts: readonly FontFile[];
    readonly families: Readonly<Record<FamilyKey, string>>;
    readonly groups: readonly TypeGroup[];
  };
  readonly spacing: TokenGroup;
  readonly radius: TokenGroup;
  readonly shadow: TokenGroup;
  readonly fontWeight: TokenGroup;
  readonly fontSize: TokenGroup;
  readonly lineHeight: TokenGroup;
  readonly letterSpacing: TokenGroup;
  readonly borderWidth: TokenGroup;
  readonly duration: TokenGroup;
  readonly easing: TokenGroup;
  readonly zIndex: TokenGroup;
}

/** The token groups after `color`, in the order tokens.css and the README list them. */
export const scalarGroups = [
  { key: "spacing", title: "Spacing and sizes" },
  { key: "radius", title: "Radius" },
  { key: "shadow", title: "Shadows and focus" },
  { key: "fontWeight", title: "Font weights" },
  { key: "fontSize", title: "Font sizes" },
  { key: "lineHeight", title: "Line heights" },
  { key: "letterSpacing", title: "Letter spacing" },
  { key: "borderWidth", title: "Border width" },
  { key: "duration", title: "Durations" },
  { key: "easing", title: "Easings" },
  { key: "zIndex", title: "Z-index" },
] as const satisfies readonly { key: keyof TokenSource; title: string }[];

export const tokenSourcePath = new URL("../tokens/tokens.json", import.meta.url);

function hasTokenList(value: unknown): boolean {
  return typeof value === "object" && value !== null && "tokens" in value && Array.isArray(value.tokens);
}

/** Checks the groups the generator walks, so a broken tokens.json fails here and not deep in a template. */
function isTokenSource(value: unknown): value is TokenSource {
  if (typeof value !== "object" || value === null || !("color" in value) || !("type" in value)) return false;
  const groups: Record<string, unknown> = { ...value };
  return hasTokenList(value.color) && typeof value.type === "object" && scalarGroups.every((group) => hasTokenList(groups[group.key]));
}

export function loadTokenSource(path: URL = tokenSourcePath): TokenSource {
  const source: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isTokenSource(source)) throw new Error(`${path.pathname} is missing a token group the generator needs.`);
  return source;
}

/** Every token of the source, colours first, in file order. */
export function allTokens(source: TokenSource): Token[] {
  return [...source.color.tokens, ...scalarGroups.flatMap((group) => source[group.key].tokens)];
}

/** The `--text-<role>` font shorthands, one per type style. */
export function typeStyles(source: TokenSource): (TypeStyle & { readonly family: FamilyKey })[] {
  return source.type.groups.flatMap((group) => group.styles.map((style) => ({ ...style, family: group.family })));
}

export function isThemed(value: TokenValue): value is { readonly light: string; readonly dark: string } {
  return typeof value !== "string";
}

/** A reference such as `{gray-50}` becomes `var(--gray-50)`; hex colours are written in lower case. */
export function cssValue(value: string): string {
  const reference = /^\{([a-z0-9-]+)\}$/.exec(value);
  if (reference !== null) return `var(--${reference[1]})`;
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value.toLowerCase() : value;
}

/** Follows `{name}` references to the literal value a token has in a theme. */
export function resolveValue(source: TokenSource, name: string, theme: "light" | "dark"): string {
  const token = allTokens(source).find((candidate) => candidate.name === name);
  if (token === undefined) throw new Error(`tokens.json has no token "${name}".`);
  const value = isThemed(token.value) ? token.value[theme] : token.value;
  const reference = /^\{([a-z0-9-]+)\}$/.exec(value);
  return reference?.[1] === undefined ? value : resolveValue(source, reference[1], theme);
}
