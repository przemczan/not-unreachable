import { cva } from "class-variance-authority";
import { useRef, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const segmentedVariants = cva("inline-flex flex-none gap-0.5 rounded-control border border-solid border-border bg-surface-sunken p-0.5", {
  variants: {
    size: {
      sm: "h-control-sm",
      md: "h-control-md",
    },
  },
  defaultVariants: { size: "md" },
});

const segmentVariants = cva(
  [
    "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-badge border-0 bg-transparent px-2.5 text-fg-2",
    "transition-colors duration-fast ease-out hover:text-fg-1 focus-visible:shadow-focus",
    "aria-checked:bg-surface aria-checked:text-fg-1 aria-checked:shadow-control aria-checked:ring-1 aria-checked:ring-border",
  ],
  {
    variants: {
      size: {
        sm: "type-caption",
        md: "type-label",
      },
    },
    defaultVariants: { size: "md" },
  },
);

/** One option of a SegmentedControl. */
export interface SegmentedOption {
  value: string;
  label: React.ReactNode;
  /** Shown before the label, usually `<Icon size={14} />`. */
  icon?: React.ReactNode;
}

export interface SegmentedControlProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue" | "role"> {
  /**
   * 2 to 5 short options: plain strings (value and label alike) or `{ value, label, icon }`.
   * @defaultValue []
   */
  options?: (string | SegmentedOption)[];
  /** The selected value, controlled. */
  value?: string;
  /** The value selected first, uncontrolled. */
  defaultValue?: string;
  /** Called with the value the user selects. */
  onChange?: (value: string) => void;
  /**
   * Height: `sm` 28px, `md` 32px.
   * @defaultValue "md"
   */
  size?: "sm" | "md";
}

/**
 * A compact single-choice toggle for time ranges, view modes and chart types: a `radiogroup` of
 * buttons. Tab reaches the selected option; the arrow keys, Home and End move and select. Name it
 * with `aria-label`.
 *
 * @example
 * <SegmentedControl aria-label="Range" size="sm" options={["24h", "7d", "30d", "90d"]} value={range} onChange={setRange} />
 */
export function SegmentedControl({ options = [], value, defaultValue, onChange, size = "md", className, ...rest }: SegmentedControlProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const selected = value ?? uncontrolledValue;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const items = options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  const selectedIndex = items.findIndex((item) => item.value === selected);
  const focusableIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const select = (index: number) => {
    const item = items[index];
    if (item === undefined) return;
    buttons.current[index]?.focus();
    if (item.value === selected) return;
    setUncontrolledValue(item.value);
    onChange?.(item.value);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = items.length - 1;
    const targets: Partial<Record<string, number>> = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
  };

  return (
    <div role="radiogroup" {...rest} className={cn(segmentedVariants({ size }), className)}>
      {items.map((item, index) => {
        const checked = item.value === selected;
        return (
          <button
            key={item.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            // A button, not a native radio: one Tab stop with the roving tabindex and selection on arrow keys, as specified.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="radio"
            aria-checked={checked}
            tabIndex={index === focusableIndex ? 0 : -1}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={segmentVariants({ size })}
          >
            {item.icon}
            {/* sm is 12px medium: type-caption sets the size, the weight goes here (type-* would override it). */}
            <span className={size === "sm" ? "font-medium" : undefined}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
