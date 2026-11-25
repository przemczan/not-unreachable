import { cva } from "class-variance-authority";
import { useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const trackVariants = cva(
  [
    "peer m-0 block flex-none cursor-pointer appearance-none rounded-full bg-border-control checked:bg-accent",
    "transition-colors duration-fast ease-out focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50",
  ],
  {
    variants: {
      size: {
        sm: "h-4 w-7",
        md: "h-5 w-8.5",
      },
    },
    defaultVariants: { size: "md" },
  },
);

const thumbVariants = cva(
  "pointer-events-none absolute top-0.5 left-0.5 rounded-full bg-fg-on-accent shadow-control transition-transform duration-base ease-out peer-disabled:opacity-50",
  {
    variants: {
      size: {
        sm: "size-3 peer-checked:translate-x-3",
        md: "size-4 peer-checked:translate-x-3.5",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "checked" | "onChange" | "size" | "role"> {
  /** On, controlled; leave it out (with `defaultChecked`) for an uncontrolled switch. */
  checked?: boolean;
  /** Called with the new state and the change event. */
  onChange?: (checked: boolean, event: React.ChangeEvent<HTMLInputElement>) => void;
  /**
   * The visible label. With a label the switch sits right-aligned in a full-width row, the settings
   * row pattern. Without it, give the switch an `aria-label`.
   */
  label?: React.ReactNode;
  /** Secondary text under the label, linked with `aria-describedby`. */
  description?: React.ReactNode;
  /**
   * Track size: `sm` 28×16px, `md` 34×20px.
   * @defaultValue "md"
   */
  size?: "sm" | "md";
  /** @defaultValue false */
  disabled?: boolean;
  /** Classes for the `<label>` around the switch and its text. */
  className?: string;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * An on/off toggle for settings that apply at once: a native checkbox with `role="switch"`.
 *
 * @example
 * <Switch checked={twoFactor} onChange={setTwoFactor} label="Two-factor authentication" description="Required for all admins" />
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  size = "md",
  disabled = false,
  className,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: SwitchProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const describedBy = [description != null ? descriptionId : undefined, ariaDescribedBy].filter(Boolean).join(" ");

  return (
    <label
      className={cn(
        "group inline-flex cursor-pointer items-start gap-3 has-disabled:cursor-not-allowed",
        label != null && "flex w-full justify-between",
        className,
      )}
    >
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
      <span className="relative flex-none">
        <input
          type="checkbox"
          // The native checkbox exposes its checked state; aria-checked would go stale when uncontrolled.
          // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props
          role="switch"
          checked={checked}
          disabled={disabled}
          // The label text alone names the control; the wrapping <label> would add the description to the name.
          aria-labelledby={label != null ? labelId : undefined}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onChange={(event) => onChange?.(event.target.checked, event)}
          className={trackVariants({ size })}
          {...rest}
        />
        <span className={thumbVariants({ size })} />
      </span>
    </label>
  );
}
