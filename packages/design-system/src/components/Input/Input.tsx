import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Field, joinIds, useFieldControl } from "../Field/index.ts";

const inputBoxVariants = cva(
  [
    "flex min-w-0 items-center gap-2 rounded-control border border-solid border-border-control bg-surface px-2.5 text-fg-3 shadow-control",
    "transition duration-fast ease-out focus-within:border-border-focus focus-within:shadow-focus",
    "has-aria-invalid:border-danger has-aria-invalid:focus-within:border-danger",
    "has-disabled:cursor-not-allowed has-disabled:bg-surface-sunken has-disabled:opacity-60",
  ],
  {
    variants: {
      size: {
        sm: "h-control-sm",
        md: "h-control-md",
        lg: "h-control-lg",
      },
    },
    defaultVariants: { size: "md" },
  },
);

const inputVariants = cva(
  [
    "h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-fg-1 shadow-none outline-none",
    "placeholder:text-fg-3 focus-visible:shadow-none disabled:cursor-not-allowed",
  ],
  {
    variants: {
      size: {
        sm: "type-body-sm",
        md: "type-body-sm",
        lg: "type-body",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** The visible label; with `label`, `hint` or `error` the input is wrapped in a Field. */
  label?: string;
  /** Helper text under the input, linked with `aria-describedby`. */
  hint?: string;
  /** Error message: turns the border red, replaces the hint and sets `aria-invalid`. */
  error?: string;
  /** Marks the label required and sets the native `required`. */
  required?: boolean | undefined;
  /**
   * Height: `sm` 28px, `md` 32px, `lg` 40px.
   * @defaultValue "md"
   */
  size?: "sm" | "md" | "lg";
  /** Leading node inside the box, usually `<Icon name="search" size={14} />`. */
  iconLeft?: React.ReactNode;
  /** Trailing node inside the box: a unit, a keyboard hint, a clear button. */
  suffix?: React.ReactNode;
  /** @defaultValue false */
  disabled?: boolean;
  /** Classes for the box around the input (border, height, width). */
  className?: string;
  /** Classes for the `<input>` element itself. */
  inputClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
}

type InputBoxProps = Omit<InputProps, "label" | "hint" | "error">;

function InputBox({
  size = "md",
  iconLeft,
  suffix,
  disabled = false,
  required,
  className,
  inputClassName,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: InputBoxProps) {
  const field = useFieldControl();
  return (
    <div className={cn(inputBoxVariants({ size }), className)}>
      {iconLeft}
      <input
        id={field?.id}
        disabled={disabled}
        required={required ?? field?.required}
        aria-describedby={joinIds(field?.describedBy, ariaDescribedBy)}
        aria-invalid={ariaInvalid ?? (field?.invalid === true ? true : undefined)}
        className={cn(inputVariants({ size }), inputClassName)}
        {...rest}
      />
      {suffix}
    </div>
  );
}

/**
 * Single-line text input with optional label, hint and error. Use `iconLeft` for search fields and
 * `suffix` for units or keyboard hints. Inside a `Field` without its own label it takes the Field's
 * wiring.
 *
 * @example
 * <Input label="Email" type="email" placeholder="name@company.com" hint="Used for sign-in" />
 * <Input aria-label="Search users" iconLeft={<Icon name="search" size={14} />} placeholder="Search users" />
 */
export function Input({ label, hint, error, required, id, ...rest }: InputProps) {
  // Always rendered through a Field, so adding an error later never remounts the input (and loses focus).
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <InputBox required={required} {...rest} />
    </Field>
  );
}
