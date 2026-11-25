import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon, type IconName } from "../Icon/index.ts";

const alertVariants = cva("flex items-start gap-2.5 rounded-card border border-solid px-3 py-2.5", {
  variants: {
    tone: {
      neutral: "border-border bg-surface-raised",
      info: "border-info-border bg-info-subtle",
      success: "border-success-border bg-success-subtle",
      warning: "border-warning-border bg-warning-subtle",
      danger: "border-danger-border bg-danger-subtle",
    },
  },
  defaultVariants: { tone: "info" },
});

const toneIcon: Record<AlertTone, { readonly name: IconName; readonly className: string }> = {
  neutral: { name: "info", className: "text-fg-2" },
  info: { name: "info", className: "text-info-fg" },
  success: { name: "circle-check", className: "text-success-fg" },
  warning: { name: "triangle-alert", className: "text-warning-fg" },
  danger: { name: "circle-alert", className: "text-danger-fg" },
};

export type AlertTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface AlertProps {
  /**
   * `info`, `success`, `warning`, `danger` (errors), `neutral`. A `danger` alert is announced at
   * once (`role="alert"`); the others politely (`role="status"`).
   * @defaultValue "info"
   */
  tone?: AlertTone;
  /** A short first line in semibold. */
  title?: React.ReactNode;
  /** The message: what happened and what to do. */
  children?: React.ReactNode;
  /** An inline Button or link on the right, such as "Try again". */
  action?: React.ReactNode;
  /** Shows a "Dismiss" button that calls it. */
  onClose?: () => void;
  className?: string;
}

/**
 * An inline message about the page or a form: sign-in errors, a "Test connection" result, a
 * warning before a risky setting. Not for transient confirmations (use a Toast).
 *
 * @example
 * <Alert tone="danger" title="Sign-in failed">The email or password is wrong.</Alert>
 */
export function Alert({ tone = "info", title, children, action, onClose, className }: AlertProps) {
  const icon = toneIcon[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn(alertVariants({ tone }), className)}>
      <span className={cn("mt-0.5 grid", icon.className)}>
        <Icon name={icon.name} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        {/* type-body-sm sets the 13px size; the weight goes on the text, as the font shorthand would override it. */}
        {title != null && <p className="m-0 type-body-sm font-semibold text-fg-1">{title}</p>}
        {children != null && <div className="type-body-sm text-fg-2">{children}</div>}
      </div>
      {action != null && <div className="flex-none">{action}</div>}
      {onClose && (
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onClose}
          className="grid flex-none cursor-pointer rounded-badge border-0 bg-transparent p-0.5 text-fg-3 hover:text-fg-1 focus-visible:shadow-focus"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
