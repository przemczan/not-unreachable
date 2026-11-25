import { cn } from "../../lib/cn.ts";
import { formatBytesOf } from "../../lib/formatBytes.ts";
import { ProgressBar, type ProgressBarTone } from "../ProgressBar/index.ts";

/** The share of the limit from which the meter warns, and from which it shows danger. */
const WARNING_SHARE = 0.8;
const DANGER_SHARE = 0.95;

export interface QuotaMeterProps {
  /** Bytes used. */
  usedBytes: number;
  /** Bytes allowed; 0 means nothing may be stored. */
  limitBytes: number;
  /**
   * The meter's name, above the bar and for screen readers.
   * @defaultValue "Storage"
   */
  label?: string;
  className?: string;
}

const captionTone: Record<ProgressBarTone, string> = {
  accent: "text-fg-2",
  neutral: "text-fg-2",
  success: "text-success-fg",
  warning: "text-warning-fg",
  danger: "text-danger-fg",
};

function toneOf(share: number): ProgressBarTone {
  if (share >= DANGER_SHARE) return "danger";
  if (share >= WARNING_SHARE) return "warning";
  return "accent";
}

/**
 * How much of a storage quota is used: a ProgressBar and a "4.2 / 10 GB" caption, in decimal
 * units. The bar turns `warning` from 80% and `danger` from 95%.
 *
 * @example
 * <QuotaMeter usedBytes={quota.usedBytes} limitBytes={quota.limitBytes} />
 */
export function QuotaMeter({ usedBytes, limitBytes, label = "Storage", className }: QuotaMeterProps) {
  const share = limitBytes > 0 ? usedBytes / limitBytes : 1;
  const tone = toneOf(share);
  const caption = formatBytesOf(usedBytes, limitBytes);
  return (
    <div className={cn("flex min-w-48 flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="type-label text-fg-2">{label}</span>
        <span className={cn("type-body-sm tabular-nums", captionTone[tone])}>{caption}</span>
      </div>
      <ProgressBar label={label} value={usedBytes} max={Math.max(limitBytes, 1)} tone={tone} valueText={caption} />
    </div>
  );
}
