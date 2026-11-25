import { cn } from "../../lib/cn.ts";
import { icons, type IconName } from "./icons.ts";

export interface IconProps {
  /** Lucide icon name in kebab-case, e.g. "users", "chevron-down"; one of the curated `icons`. */
  readonly name: IconName;
  /** px. 14 in sm controls, 16 default, 20 for nav and empty states. */
  readonly size?: 14 | 16 | 20;
  readonly strokeWidth?: number;
  /** A CSS colour, normally a token: `"var(--accent)"`. Defaults to `currentColor`. */
  readonly color?: string;
  readonly className?: string;
}

/**
 * A Lucide icon, bundled (never loaded from a CDN), stroke 1.75, decorative (`aria-hidden`): give
 * the control around it its accessible name.
 *
 * @example <Icon name="users" size={20} />
 */
export function Icon({ name, size = 16, strokeWidth = 1.75, color = "currentColor", className }: IconProps) {
  const Glyph = icons[name];
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      color={color}
      aria-hidden="true"
      focusable="false"
      className={cn("block flex-none", className)}
    />
  );
}
