import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Field, joinIds, useFieldControl } from "../Field/index.ts";

const textareaClasses = [
  "block w-full resize-y rounded-control border border-solid border-border-control bg-surface px-2.5 py-2 type-body-sm text-fg-1 shadow-control outline-none",
  "transition duration-fast ease-out placeholder:text-fg-3 focus-visible:border-border-focus focus-visible:shadow-focus",
  "aria-invalid:border-danger aria-invalid:focus-visible:border-danger",
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60",
];

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** The visible label; with `label`, `hint` or `error` the textarea is wrapped in a Field. */
  label?: string;
  /** Helper text under the textarea, linked with `aria-describedby`. */
  hint?: string;
  /** Error message: turns the border red, replaces the hint and sets `aria-invalid`. */
  error?: string;
  /** Marks the label required and sets the native `required`. */
  required?: boolean | undefined;
  /**
   * Visible lines of text; the user can resize it vertically.
   * @defaultValue 4
   */
  rows?: number;
  /** @defaultValue false */
  disabled?: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}

type TextareaControlProps = Omit<TextareaProps, "label" | "hint" | "error">;

function TextareaControl({
  rows = 4,
  disabled = false,
  required,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: TextareaControlProps) {
  const field = useFieldControl();
  return (
    <textarea
      id={field?.id}
      rows={rows}
      disabled={disabled}
      required={required ?? field?.required}
      aria-describedby={joinIds(field?.describedBy, ariaDescribedBy)}
      aria-invalid={ariaInvalid ?? (field?.invalid === true ? true : undefined)}
      className={cn(textareaClasses, className)}
      {...rest}
    />
  );
}

/**
 * Multi-line text input for notes, descriptions and reasons, with optional label, hint and error.
 *
 * @example
 * <Textarea label="Internal note" rows={3} hint="Only visible to admins" />
 */
export function Textarea({ label, hint, error, required, id, ...rest }: TextareaProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <TextareaControl required={required} {...rest} />
    </Field>
  );
}
