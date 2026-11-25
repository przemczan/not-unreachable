import { useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../Icon/index.ts";

export interface DisclosureProps {
  /** The line that opens and closes it, such as "How to set this up". */
  title: React.ReactNode;
  /** What it shows while open. */
  children: React.ReactNode;
  /**
   * Whether it starts open; after that the person opens and closes it.
   * @defaultValue false
   */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * A titled block that folds away: help or detail a form doesn't always need. A native
 * `<details>`, so the keyboard and screen readers handle it as a disclosure.
 *
 * @example
 * <Disclosure title="How to set this up" defaultOpen>…</Disclosure>
 */
export function Disclosure({ title, children, defaultOpen = false, className }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={cn("group rounded-card border border-solid border-border bg-surface-raised", className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-card px-3 py-2.5 type-body-sm font-semibold text-fg-1 focus-visible:shadow-focus [&::-webkit-details-marker]:hidden">
        <span className="grid text-fg-3 transition-transform group-open:rotate-90">
          <Icon name="chevron-right" size={14} />
        </span>
        {title}
      </summary>
      <div className="px-3 pb-3 type-body-sm text-fg-2">{children}</div>
    </details>
  );
}
