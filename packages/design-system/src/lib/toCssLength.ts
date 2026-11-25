/**
 * Lets `style` take CSS custom properties, the only thing a component may set inline
 * (`style={{ "--nu-menu-x": toCssLength(x) }}`), without a cast. It lives here because the
 * components that set them import this module.
 */
declare module "react" {
  interface CSSProperties {
    [customProperty: `--${string}`]: string | number | undefined;
  }
}

/**
 * Turns a number of CSS pixels into a CSS length, for the custom properties a component sets at run
 * time (a popover's measured position, a Menu's width prop) and its classes read, such as
 * `left-(--nu-menu-x)`.
 *
 * It is the one place in the design system that writes a unit onto a number: components never put
 * raw lengths in `style`, they pass numbers through here, so the raw-style-values lint rule only has
 * this file to allow.
 *
 * @example toCssLength(12) // "12px"
 */
export function toCssLength(pixels: number): string {
  return `${Number.isFinite(pixels) ? pixels : 0}px`;
}
