import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Field, joinIds, useFieldControl } from "../Field/index.ts";
import { Icon } from "../Icon/index.ts";

const selectVariants = cva(
  [
    "block w-full cursor-pointer appearance-none rounded-control border border-solid border-border-control bg-surface pr-8 pl-2.5 text-fg-1 shadow-control outline-none",
    "transition duration-fast ease-out focus-visible:border-border-focus focus-visible:shadow-focus",
    "aria-invalid:border-danger aria-invalid:focus-visible:border-danger",
    "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60",
  ],
  {
    variants: {
      size: {
        sm: "h-control-sm type-body-sm",
        md: "h-control-md type-body-sm",
        lg: "h-control-lg type-body",
      },
    },
    defaultVariants: { size: "md" },
  },
);

/** One option of a Select. */
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  "size" | "value" | "defaultValue" | "onChange" | "multiple"
> {
  /** The visible label; with `label`, `hint` or `error` the select is wrapped in a Field. */
  label?: string;
  /** Helper text under the select, linked with `aria-describedby`. */
  hint?: string;
  /** Error message: turns the border red, replaces the hint and sets `aria-invalid`. */
  error?: string;
  /** Marks the label required and sets the native `required`. */
  required?: boolean | undefined;
  /**
   * The options: plain strings (value and label alike) or `{ value, label }`.
   * @defaultValue []
   */
  options?: (string | SelectOption)[];
  /** The selected value, controlled. */
  value?: string;
  /** The value selected first, uncontrolled. */
  defaultValue?: string;
  /** Called with the newly selected value and the change event. */
  onChange?: (value: string, event: React.ChangeEvent<HTMLSelectElement>) => void;
  /** A first, disabled option with an empty value, shown until the user picks one. */
  placeholder?: string;
  /**
   * Height: `sm` 28px, `md` 32px, `lg` 40px.
   * @defaultValue "md"
   */
  size?: "sm" | "md" | "lg";
  /** @defaultValue false */
  disabled?: boolean;
  /** The select's `id`; generated when left out. */
  id?: string;
  /** Classes for the wrapper around the select (width, margins). */
  className?: string;
  ref?: React.Ref<HTMLSelectElement>;
}

type SelectControlProps = Omit<SelectProps, "label" | "hint" | "error" | "id">;

function SelectControl({
  options = [],
  value,
  defaultValue,
  onChange,
  placeholder,
  size = "md",
  disabled = false,
  required,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: SelectControlProps) {
  const field = useFieldControl();
  // Without a value, the browser would select the first real option: start on the placeholder instead.
  const initialValue = defaultValue ?? (value === undefined && placeholder !== undefined ? "" : undefined);
  return (
    <div className={cn("relative min-w-0", className)}>
      <select
        id={field?.id}
        value={value}
        defaultValue={initialValue}
        disabled={disabled}
        required={required ?? field?.required}
        aria-describedby={joinIds(field?.describedBy, ariaDescribedBy)}
        aria-invalid={ariaInvalid ?? (field?.invalid === true ? true : undefined)}
        onChange={(event) => onChange?.(event.target.value, event)}
        className={selectVariants({ size })}
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => {
          const { value: optionValue, label } = typeof option === "string" ? { value: option, label: option } : option;
          return (
            <option key={optionValue} value={optionValue}>
              {label}
            </option>
          );
        })}
      </select>
      <Icon name="chevron-down" size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-3" />
    </div>
  );
}

/**
 * A native dropdown styled like Input, for forms and table filters, with optional label, hint and
 * error. Options come from `options`, as strings or `{ value, label }`.
 *
 * @example
 * <Select label="Role" options={["Admin", "Editor", "Viewer"]} defaultValue="Viewer" />
 * <Select size="sm" aria-label="Status" options={[{ value: "all", label: "All statuses" }, { value: "active", label: "Active" }]} />
 */
export function Select({ label, hint, error, required, id, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <SelectControl required={required} {...rest} />
    </Field>
  );
}
