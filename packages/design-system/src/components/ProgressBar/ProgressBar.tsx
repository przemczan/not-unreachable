import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const trackVariants = cva("relative w-full overflow-hidden rounded-full bg-border", {
  variants: {
    size: { sm: "h-1", md: "h-1.5", lg: "h-2" },
  },
  defaultVariants: { size: "md" },
});

const fillVariants = cva("block h-full rounded-full transition-all duration-base ease-out", {
  variants: {
    tone: {
      accent: "bg-accent",
      neutral: "bg-fg-3",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
    },
  },
  defaultVariants: { tone: "accent" },
});

export type ProgressBarTone = "accent" | "neutral" | "success" | "warning" | "danger";

export interface ProgressBarProps {
  /** How far along, from 0 to `max`; left out for an indeterminate bar (a faint third of the track). */
  value?: number | undefined;
  /** @defaultValue 100 */
  max?: number;
  /**
   * The fill's colour: `accent` while working, `success` when done, `warning` / `danger` near a limit.
   * @defaultValue "accent"
   */
  tone?: ProgressBarTone;
  /**
   * Track height: `sm` 4px, `md` 6px, `lg` 8px.
   * @defaultValue "md"
   */
  size?: "sm" | "md" | "lg";
  /** Names the bar for screen readers (`aria-label`): "Upload of report.pdf". */
  label?: string;
  /** The value as words, for screen readers (`aria-valuetext`): "4.2 of 10 GB". */
  valueText?: string;
  className?: string;
}

/** The share of `max` that `value` is, as a CSS percentage between 0% and 100%. */
function percentOf(value: number, max: number): string {
  const share = max > 0 ? value / max : 0;
  return `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%`;
}

/**
 * A thin horizontal bar showing how far along a task or a share of a limit is: an upload, a
 * quota. A `progressbar` with `aria-valuenow`; without `value` it is indeterminate.
 *
 * @example
 * <ProgressBar label="Upload of report.pdf" value={bytesSent} max={bytesTotal} />
 */
export function ProgressBar({ value, max = 100, tone = "accent", size = "md", label, valueText, className }: ProgressBarProps) {
  const determinate = value !== undefined && Number.isFinite(value);
  return (
    <div
      // A native <progress> can't take the theme's fill and track without vendor pseudo-elements.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? max : undefined}
      aria-valuenow={determinate ? Math.min(max, Math.max(0, value)) : undefined}
      aria-valuetext={valueText}
      className={cn(trackVariants({ size }), className)}
    >
      <span
        style={{ "--nu-progress": determinate ? percentOf(value, max) : undefined }}
        className={cn(fillVariants({ tone }), determinate ? "w-(--nu-progress)" : "w-1/3 opacity-60")}
      />
    </div>
  );
}
