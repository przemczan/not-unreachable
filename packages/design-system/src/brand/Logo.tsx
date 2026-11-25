import { cn, toCssLength } from "../lib/index.ts";
import { MARK_VIEW_BOX, markCut } from "./mark.ts";
import { PRODUCT_NAME } from "./product-name.ts";
import { toneClasses, type BrandTone } from "./tone.ts";
import { Wordmark } from "./Wordmark.tsx";

export interface LogoProps {
  /**
   * `horizontal`: the mark and the Wordmark; `mark`: the mark alone, for the collapsed sidebar.
   * @defaultValue "horizontal"
   */
  variant?: "horizontal" | "mark";
  /**
   * `auto` follows the theme (`fg-1` text, accent glyph); `light` / `dark` keep that theme's colours;
   * `mono-ink` / `mono-white` draw it in one colour.
   * @defaultValue "auto"
   */
  tone?: BrandTone;
  /**
   * The lockup's height (the mark's side), in px.
   * @defaultValue 24
   */
  size?: number;
  className?: string;
}

interface MarkProps {
  readonly className: string;
  /** Names the mark when it stands alone; left out, the mark is decorative (the Wordmark names the logo). */
  readonly label?: string | undefined;
}

/**
 * The mark (see mark.ts): the "nu" route in the accent colour on a sunken rounded square. The same
 * drawing as brand/logo-mark.svg, inline so it takes the theme's colours.
 */
function Mark({ className, label }: MarkProps) {
  const { route, routeWidth, node } = markCut;
  return (
    <span className={cn("inline-grid size-(--nu-logo-size) flex-none place-items-center rounded-control", className)}>
      <svg
        viewBox={MARK_VIEW_BOX}
        focusable="false"
        {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
        className="block size-full"
      >
        <path d={route} fill="none" stroke="currentColor" strokeWidth={routeWidth} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={node.cx} cy={node.cy} r={node.r} fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * NotUnreachable's logo: the mark and the Wordmark, or the mark alone. It is the only way screens
 * show the brand. The Wordmark's live text names it; the mark alone is an image named
 * "NotUnreachable".
 *
 * @example
 * <Logo />
 * <Logo variant="mark" size={28} />
 */
export function Logo({ variant = "horizontal", tone = "auto", size = 24, className }: LogoProps) {
  const { theme, mark } = toneClasses(tone);
  return (
    <span
      data-theme={theme}
      style={{ "--nu-logo-size": toCssLength(size) }}
      className={cn("inline-flex flex-none items-center gap-2", className)}
    >
      <Mark className={mark} label={variant === "mark" ? PRODUCT_NAME : undefined} />
      {variant === "horizontal" && <Wordmark tone={tone} size={Math.round(size * 0.75)} />}
    </span>
  );
}
