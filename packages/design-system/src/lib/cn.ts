import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Teaches tailwind-merge our theme (see the `@theme` block of theme.css): its named spacing,
 * radius, shadow and container sizes, and the class groups theme.css adds as `@utility`s. Without
 * this `cn("type-body", "type-label")` or `cn("px-page", "px-4")` would keep both classes and the
 * cascade would pick one at random.
 */
const twMerge = extendTailwindMerge<"type-role" | "duration-token" | "z-token">({
  override: {
    theme: {
      radius: ["control", "card", "dialog", "badge", "full"],
      shadow: ["control", "raised", "floating", "focus"],
      container: ["content"],
    },
  },
  extend: {
    theme: {
      spacing: [
        "control-xs",
        "control-sm",
        "control-md",
        "control-lg",
        "row-compact",
        "row",
        "row-relaxed",
        "sidebar",
        "sidebar-collapsed",
        "topbar",
        "page",
        "card",
      ],
    },
    classGroups: {
      "type-role": [
        {
          type: [
            "page-title",
            "section-title",
            "card-title",
            "body",
            "body-sm",
            "label",
            "caption",
            "metric",
            "metric-sm",
            "overline",
            "mono",
          ],
        },
      ],
      "duration-token": [{ duration: ["instant", "fast", "base", "slow"] }],
      "z-token": [{ z: ["base", "sticky", "dropdown", "drawer", "modal", "toast", "tooltip"] }],
    },
    conflictingClassGroups: {
      "type-role": ["font-size", "leading", "font-weight", "font-family", "tracking"],
    },
  },
});

/** Joins class names and lets a later class win over an earlier one of the same group. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
