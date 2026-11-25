import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

/**
 * Solid surface: the source's 88% surface over a backdrop blur needs a blur token the theme doesn't
 * have, and a translucent bar without the blur shows the page through it.
 */
const topbarVariants = cva(
  "top-0 z-sticky flex h-topbar flex-none items-center gap-4 border-b border-solid border-border bg-surface px-page",
  {
    variants: {
      sticky: { true: "sticky", false: "relative" },
    },
    defaultVariants: { sticky: true },
  },
);

export interface TopbarProps {
  /** Breadcrumbs or the sidebar toggle. */
  left?: React.ReactNode;
  /** Global search. */
  center?: React.ReactNode;
  /** Notifications, the theme switch, the user's Avatar. */
  right?: React.ReactNode;
  /**
   * Sticks to the top of the scrolling content.
   * @defaultValue true
   */
  sticky?: boolean;
  className?: string;
}

/**
 * The 56px app bar above the content area: breadcrumbs at the left, search in the centre,
 * utilities at the right.
 *
 * @example
 * <Topbar left={<Breadcrumbs items={[{ label: "Users" }, { label: "Marta Kowalska" }]} />} right={<Avatar name="Jan Nowak" size="sm" />} />
 */
export function Topbar({ left, center, right, sticky = true, className }: TopbarProps) {
  return (
    <header className={cn(topbarVariants({ sticky }), className)}>
      <div className="flex min-w-50 flex-auto items-center gap-3">{left}</div>
      {center != null && <div className="min-w-40 shrink grow-0 basis-80">{center}</div>}
      <div className="flex flex-none items-center justify-end gap-1.5">{right}</div>
    </header>
  );
}
