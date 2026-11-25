import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const tagVariants = cva(
  "inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-solid type-label transition-colors duration-fast ease-out select-none",
  {
    variants: {
      selected: {
        true: "border-fg-1 bg-surface-inverse text-fg-inverse",
        false: "border-border-strong bg-surface text-fg-1",
      },
      removable: { true: "pr-1.5 pl-2.5", false: "px-2.5" },
    },
  },
);

const pressableClasses = "cursor-pointer focus-visible:shadow-focus";

export interface TagProps {
  /**
   * The filter is on: ink fill. Announced as a pressed toggle when the tag has `onClick`.
   * @defaultValue false
   */
  selected?: boolean;
  /** Makes the tag a toggle button (`aria-pressed`): a filter chip such as an outcome filter. */
  onClick?: () => void;
  /** Shows a × button that calls it: for applied filters. */
  onRemove?: () => void;
  /**
   * The × button's accessible name.
   * @defaultValue "Remove filter"
   */
  removeLabel?: string;
  /** A leading icon, usually `<Icon size={14} />`. */
  icon?: React.ReactNode;
  /** A trailing count, such as the results per filter. */
  count?: number;
  children?: React.ReactNode;
  className?: string;
}

/**
 * A pill-shaped filter chip. With `onClick` it is a toggle button (`aria-pressed`), ink-filled when
 * `selected`; with `onRemove` it gets a × to clear an applied filter; with neither, a static label.
 *
 * @example
 * <Tag selected={outcomes.has("failure")} onClick={() => toggle("failure")} count={12}>Failed</Tag>
 */
export function Tag({ selected = false, onClick, onRemove, removeLabel = "Remove filter", icon, count, children, className }: TagProps) {
  const content = (
    <>
      {icon}
      {children}
      {count != null && <span className="font-mono opacity-70 tabular-nums">{count}</span>}
    </>
  );

  if (onRemove === undefined) {
    const classes = cn(tagVariants({ selected, removable: false }), className);
    return onClick ? (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        className={cn(classes, pressableClasses, !selected && "hover:bg-control-hover")}
      >
        {content}
      </button>
    ) : (
      <span className={classes}>{content}</span>
    );
  }

  return (
    <span className={cn(tagVariants({ selected, removable: true }), className)}>
      {onClick ? (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onClick}
          className={cn("inline-flex items-center gap-1.5 rounded-full border-0 bg-transparent p-0 text-inherit", pressableClasses)}
        >
          {content}
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5">{content}</span>
      )}
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className={cn(
          "grid size-4.5 place-items-center rounded-full border-0 bg-transparent p-0 text-inherit opacity-70",
          pressableClasses,
        )}
      >
        <span aria-hidden="true">×</span>
      </button>
    </span>
  );
}
