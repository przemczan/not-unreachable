import { useEffect, useId, useRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../Icon/index.ts";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "checked" | "onChange" | "size"> {
  /** Checked, controlled; leave it out (with `defaultChecked`) for an uncontrolled checkbox. */
  checked?: boolean;
  /**
   * Mixed state, such as "select all" when only some rows are selected. Shown over `checked`.
   * @defaultValue false
   */
  indeterminate?: boolean;
  /** Called with the new checked state and the change event. */
  onChange?: (checked: boolean, event: React.ChangeEvent<HTMLInputElement>) => void;
  /** The visible label, beside the box. Without it, give the checkbox an `aria-label`. */
  label?: React.ReactNode;
  /** Secondary text under the label, linked with `aria-describedby`. */
  description?: React.ReactNode;
  /** @defaultValue false */
  disabled?: boolean;
  /** Classes for the `<label>` around the box and its text. */
  className?: string;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * A 16px native checkbox, ember when checked, with optional label and description. Supports the
 * indeterminate state for table select-all.
 *
 * @example
 * <Checkbox checked={weekly} onChange={setWeekly} label="Send weekly report" description="Every Monday at 08:00" />
 * <Checkbox aria-label="Select all rows" indeterminate />
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  description,
  disabled = false,
  className,
  ref,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;

  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const setRef = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const describedBy = [description != null ? descriptionId : undefined, ariaDescribedBy].filter(Boolean).join(" ");

  return (
    <label className={cn("group inline-flex cursor-pointer items-start gap-2 has-disabled:cursor-not-allowed", className)}>
      <span className="relative grid size-4 flex-none place-items-center">
        <input
          ref={setRef}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          // The label text alone names the control; the wrapping <label> would add the description to the name.
          aria-labelledby={label != null ? labelId : undefined}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onChange={(event) => onChange?.(event.target.checked, event)}
          className={cn(
            "peer absolute inset-0 m-0 size-4 cursor-pointer appearance-none rounded-badge border border-solid border-border-control bg-surface",
            "transition-colors duration-fast ease-out focus-visible:shadow-focus",
            "checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          {...rest}
        />
        <Icon
          name="check"
          size={14}
          strokeWidth={3}
          className="pointer-events-none relative hidden text-fg-on-accent peer-checked:block peer-indeterminate:hidden"
        />
        <Icon
          name="minus"
          size={14}
          strokeWidth={3}
          className="pointer-events-none absolute hidden text-fg-on-accent peer-indeterminate:block"
        />
      </span>
      {label != null && (
        <span className="flex flex-col">
          <span id={labelId} className="type-label text-fg-1 group-has-disabled:text-fg-disabled">
            {label}
          </span>
          {description != null && (
            <span id={descriptionId} className="type-caption text-fg-3">
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
}
