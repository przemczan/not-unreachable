import { isThemed, type Token } from "./token-source.ts";

/**
 * How each token of tokens.json reaches Tailwind (design-system.md, "Tokens → Tailwind"): as a
 * theme variable, as an `@utility`, or not at all, with the reason. A token none of these rules
 * covers stops the generator, so a new token can't silently map to nothing.
 */
export type Exposure =
  | { readonly kind: "theme"; readonly variable: string }
  | { readonly kind: "utility"; readonly utility: string; readonly property: string }
  | { readonly kind: "not-exposed"; readonly reason: string };

export type GroupKey =
  | "color"
  | "spacing"
  | "radius"
  | "shadow"
  | "fontWeight"
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "borderWidth"
  | "duration"
  | "easing"
  | "zIndex";

/** Colour aliases whose class differs from the token's name. */
const colorRenames: Readonly<Record<string, string>> = {
  "sidebar-bg": "sidebar",
  "sidebar-active-bg": "sidebar-active",
  "text-link": "link",
  "text-link-hover": "link-hover",
};

const layoutSizes: Readonly<Record<string, string>> = {
  "space-1": "--spacing",
  "control-xs": "--spacing-control-xs",
  "control-sm": "--spacing-control-sm",
  "control-md": "--spacing-control-md",
  "control-lg": "--spacing-control-lg",
  "row-compact": "--spacing-row-compact",
  "row-default": "--spacing-row",
  "row-relaxed": "--spacing-row-relaxed",
  "sidebar-width": "--spacing-sidebar",
  "sidebar-collapsed": "--spacing-sidebar-collapsed",
  "topbar-height": "--spacing-topbar",
  "page-padding": "--spacing-page",
  "card-padding": "--spacing-card",
  "content-max": "--container-content",
};

const shadows: Readonly<Record<string, string>> = {
  "shadow-1": "--shadow-control",
  "shadow-2": "--shadow-raised",
  "shadow-3": "--shadow-floating",
  "focus-ring": "--shadow-focus",
};

const fontWeights: Readonly<Record<string, string>> = {
  "weight-regular": "--font-weight-normal",
  "weight-medium": "--font-weight-medium",
  "weight-semibold": "--font-weight-semibold",
};

/**
 * The radius roles of the source's component stylesheet: screens round corners by role, never by
 * size. tokens.css defines them; theme.css exposes them as `rounded-<role>`.
 */
export const radiusRoles: Readonly<Record<string, string>> = {
  "radius-control": "radius-md",
  "radius-card": "radius-lg",
  "radius-dialog": "radius-xl",
  "radius-badge": "radius-sm",
};

function themeVariable(variable: string): Exposure {
  return { kind: "theme", variable };
}

function notExposed(reason: string): Exposure {
  return { kind: "not-exposed", reason };
}

function colorExposure(token: Token): Exposure {
  if (token.name.startsWith("chart-")) return notExposed("Charts are not ported yet; the first chart exposes these.");
  // A literal value is a ramp step; aliases are references or per-theme values.
  if (!isThemed(token.value) && !token.value.startsWith("{")) return notExposed("A ramp: use it through the semantic aliases.");
  return themeVariable(`--color-${colorRenames[token.name] ?? token.name}`);
}

/** Maps a token through a table; one not in it is `notExposed` for the reason given, or an error without one. */
function lookup(table: Readonly<Record<string, string>>, token: Token, otherwise?: string): Exposure {
  const variable = table[token.name];
  if (variable !== undefined) return themeVariable(variable);
  if (otherwise === undefined) throw new Error(`No theme mapping for the token "${token.name}": add it to scripts/theme-mapping.ts.`);
  return notExposed(otherwise);
}

function radiusExposure(token: Token): Exposure {
  if (token.name === "radius-full") return themeVariable("--radius-full");
  if (token.name === "radius-0") return notExposed("`rounded-none`.");
  return notExposed("Reached through the radius roles: rounded-control, rounded-card, rounded-dialog, rounded-badge.");
}

function sameName(token: Token): Exposure {
  return themeVariable(`--${token.name}`);
}

/** One mapping per token group; the Record type makes a new group in tokens.json a compile error here. */
const exposureByGroup: Readonly<Record<GroupKey, (token: Token) => Exposure>> = {
  color: colorExposure,
  spacing: (token) => lookup(layoutSizes, token, "A multiple of --spacing (space-1): `p-5` is space-5."),
  radius: radiusExposure,
  shadow: (token) => lookup(shadows, token, "`shadow-none`."),
  fontWeight: (token) => lookup(fontWeights, token),
  fontSize: () => notExposed("Font sizes are set by the type-* roles, never one by one."),
  lineHeight: sameName,
  letterSpacing: sameName,
  easing: sameName,
  borderWidth: () => notExposed("Tailwind's `border` is this 1px."),
  duration: (token) => ({ kind: "utility", utility: token.name, property: "transition-duration" }),
  zIndex: (token) => ({ kind: "utility", utility: token.name, property: "z-index" }),
};

export function exposureOf(group: GroupKey, token: Token): Exposure {
  return exposureByGroup[group](token);
}

/** The Tailwind namespaces theme.css empties before mapping tokens in, so no default value is left. */
export const resetNamespaces = [
  "--color-*",
  "--container-*",
  "--radius-*",
  "--shadow-*",
  "--inset-shadow-*",
  "--drop-shadow-*",
  "--text-shadow-*",
  "--blur-*",
  "--text-*",
  "--font-*",
  "--leading-*",
  "--tracking-*",
  "--ease-*",
  "--animate-*",
] as const;
