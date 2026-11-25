/**
 * The brand's colour treatments.
 * - `auto` follows the page's theme;
 * - `light` / `dark` keep the light or dark theme's colours, whatever the page's theme;
 * - `mono-ink` / `mono-white` draw everything in one colour, ink or white, with no square behind the glyph.
 */
export type BrandTone = "auto" | "light" | "dark" | "mono-ink" | "mono-white";

export interface ToneClasses {
  /** The theme the brand's colours are read from, set as `data-theme` on its root; none for `auto`. */
  readonly theme: "light" | "dark" | undefined;
  /** The wordmark's text colour. */
  readonly text: string;
  /** The mark's glyph colour and square. */
  readonly mark: string;
}

const tones: Record<BrandTone, ToneClasses> = {
  auto: { theme: undefined, text: "text-fg-1", mark: "bg-surface-sunken text-accent" },
  light: { theme: "light", text: "text-fg-1", mark: "bg-surface-sunken text-accent" },
  dark: { theme: "dark", text: "text-fg-1", mark: "bg-surface-sunken text-accent" },
  "mono-ink": { theme: "light", text: "text-fg-1", mark: "bg-transparent text-fg-1" },
  "mono-white": { theme: "light", text: "text-fg-inverse", mark: "bg-transparent text-fg-inverse" },
};

/** The classes and theme of a tone; an unknown tone falls back to `auto`. */
export function toneClasses(tone: BrandTone): ToneClasses {
  return tones[tone] ?? tones.auto;
}
