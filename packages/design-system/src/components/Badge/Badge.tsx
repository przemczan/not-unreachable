import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const badgeVariants = cva("inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-badge border border-solid type-caption", {
  variants: {
    tone: {
      neutral: "border-neutral-border bg-neutral-subtle text-neutral-fg",
      accent: "border-accent-subtle bg-accent-subtle text-accent-subtle-fg",
      success: "border-success-border bg-success-subtle text-success-fg",
      warning: "border-warning-border bg-warning-subtle text-warning-fg",
      danger: "border-danger-border bg-danger-subtle text-danger-fg",
      info: "border-info-border bg-info-subtle text-info-fg",
    },
    size: {
      sm: "h-4.5 px-1.5",
      md: "h-5.5 px-2",
    },
  },
  defaultVariants: { tone: "neutral", size: "md" },
});

const dotTone = {
  neutral: "bg-fg-3",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
} as const;

export interface BadgeProps {
  /**
   * Status colour: `neutral` inactive or draft, `success` active, `warning` pending, `danger`
   * failed or blocked, `info` informational, `accent` brand or new. Never rely on colour alone:
   * always include a word.
   * @defaultValue "neutral"
   */
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
  /**
   * A leading status dot; use it in tables for a record's status.
   * @defaultValue false
   */
  dot?: boolean;
  /**
   * Geist Mono, for IDs, versions and codes.
   * @defaultValue false
   */
  mono?: boolean;
  /**
   * Height: `sm` 18px, `md` 22px.
   * @defaultValue "md"
   */
  size?: "sm" | "md";
  children?: React.ReactNode;
  className?: string;
}

/**
 * A compact status or label chip: the main way to show a record's status in tables and headers.
 *
 * @example
 * <Badge tone="success" dot>Active</Badge>
 * <Badge mono>v2.4.1</Badge>
 */
export function Badge({ tone = "neutral", dot = false, mono = false, size = "md", children, className }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)}>
      {dot && <span aria-hidden="true" className={cn("size-1.5 flex-none rounded-full", dotTone[tone])} />}
      {/* type-caption sets the size; weight and family go on the text, as the font shorthand would override them. */}
      <span className={cn("font-medium", mono && "font-mono")}>{children}</span>
    </span>
  );
}
