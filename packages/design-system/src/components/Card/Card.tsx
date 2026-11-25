import { cva } from "class-variance-authority";
import { useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const cardVariants = cva("flex min-w-0 flex-col rounded-card border border-solid border-border", {
  variants: {
    variant: {
      outline: "bg-surface",
      raised: "bg-surface-raised shadow-raised",
      sunken: "bg-surface-sunken",
    },
  },
  defaultVariants: { variant: "outline" },
});

/** Header padding: 2px less on top than the sides; `none` gets a divider and its own bottom padding. */
const headerPadding = cva("flex items-start gap-3", {
  variants: {
    padding: {
      none: "border-b border-solid border-border px-4 py-3.5",
      sm: "px-4 pt-3.5",
      md: "px-5 pt-4.5",
      lg: "px-6 pt-5.5",
    },
  },
});

const bodyPadding = cva("min-w-0 flex-1", {
  variants: {
    padding: { none: "p-0", sm: "p-4", md: "p-5", lg: "p-6" },
    headed: { true: "", false: "" },
  },
  compoundVariants: [{ padding: ["sm", "md", "lg"], headed: true, className: "pt-3.5" }],
});

const footerPadding = cva("border-t border-solid border-border py-3 type-body-sm text-fg-2", {
  variants: {
    padding: { none: "px-4", sm: "px-4", md: "px-5", lg: "px-6" },
  },
});

export interface CardProps {
  /** The card's heading; it also names the card's region. */
  title?: React.ReactNode;
  /** A line under the title. */
  subtitle?: React.ReactNode;
  /** Controls at the right of the header: IconButton, SegmentedControl, Menu. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * `outline` (no shadow), `raised` (raised shadow), `sunken` (inset panels).
   * @defaultValue "outline"
   */
  variant?: "outline" | "raised" | "sunken";
  /**
   * Body padding: `sm` 16px, `md` 20px, `lg` 24px; `none` is an edge-to-edge body (tables, lists)
   * with a divider under the header.
   * @defaultValue "md"
   */
  padding?: "none" | "sm" | "md" | "lg";
  children?: React.ReactNode;
  /** Classes for the card itself. */
  className?: string;
  /** Classes for the body around `children`. */
  bodyClassName?: string;
}

/**
 * A bordered container for dashboard widgets, forms and tables, with an optional header (title,
 * subtitle, actions) and footer.
 *
 * @example
 * <Card title="Revenue" subtitle="Last 30 days" actions={<IconButton label="More" icon={<Icon name="more-horizontal" />} />}>
 *   …
 * </Card>
 */
export function Card({
  title,
  subtitle,
  actions,
  footer,
  variant = "outline",
  padding = "md",
  children,
  className,
  bodyClassName,
}: CardProps) {
  const titleId = useId();
  const headed = title != null || actions != null;
  return (
    <section aria-labelledby={title != null ? titleId : undefined} className={cn(cardVariants({ variant }), className)}>
      {headed && (
        <header className={headerPadding({ padding })}>
          <div className="min-w-0 flex-1">
            {title != null && (
              <h3 id={titleId} className="m-0 type-card-title text-fg-1">
                {title}
              </h3>
            )}
            {subtitle != null && <p className="m-0 mt-0.5 type-body-sm text-fg-3">{subtitle}</p>}
          </div>
          {actions != null && <div className="-mt-1 -mr-1 flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn(bodyPadding({ padding, headed }), bodyClassName)}>{children}</div>
      {footer != null && <footer className={footerPadding({ padding })}>{footer}</footer>}
    </section>
  );
}
