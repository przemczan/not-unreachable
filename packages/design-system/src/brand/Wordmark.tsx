import { cn, toCssLength } from "../lib/index.ts";
import { PRODUCT_NAME } from "./product-name.ts";
import { toneClasses, type BrandTone } from "./tone.ts";

export interface WordmarkProps {
  /**
   * `auto` follows the theme; `light` / `dark` keep that theme's colours; `mono-ink` / `mono-white`
   * are one colour.
   * @defaultValue "auto"
   */
  tone?: BrandTone;
  /**
   * The name's font size, in px.
   * @defaultValue 16
   */
  size?: number;
  className?: string;
}

/**
 * The name "NotUnreachable" as live text: Geist semibold, tight tracking, `fg-1`. Screens show it
 * through `<Logo />`; use the Wordmark alone only where the mark would repeat a nearby one.
 *
 * @example <Wordmark size={18} />
 */
export function Wordmark({ tone = "auto", size = 16, className }: WordmarkProps) {
  const { theme, text } = toneClasses(tone);
  return (
    <span
      data-theme={theme}
      style={{ "--nu-wordmark-size": toCssLength(size) }}
      className={cn(
        "font-sans text-(length:--nu-wordmark-size) leading-none font-semibold tracking-tight whitespace-nowrap",
        text,
        className,
      )}
    >
      {PRODUCT_NAME}
    </span>
  );
}
