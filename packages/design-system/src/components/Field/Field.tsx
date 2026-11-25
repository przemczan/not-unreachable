import { createContext, use, useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

/** What a Field tells the control inside it. */
export interface FieldControlProps {
  /** The `id` the control takes, so the Field's `<label htmlFor>` names it. */
  id: string;
  /** The id of the hint or error message, for the control's `aria-describedby`; undefined without one. */
  describedBy: string | undefined;
  /** True when the Field shows an error: the control sets `aria-invalid`. */
  invalid: boolean;
  /** True when the Field is marked required: the control sets `required`. */
  required: boolean;
}

const FieldContext = createContext<FieldControlProps | null>(null);

/**
 * The wiring of the Field around a control: its `id`, `aria-describedby`, `aria-invalid` and
 * `required`. Null outside a Field. Input, Textarea and Select read it; a custom control can too.
 */
export function useFieldControl(): FieldControlProps | null {
  return use(FieldContext);
}

/** Joins `aria-describedby` id lists, leaving out empty ones. */
export function joinIds(...ids: (string | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}

export interface FieldProps {
  /** The visible label, a `<label>` for the control. */
  label?: string | undefined;
  /** Helper text under the control, linked with `aria-describedby`. */
  hint?: string | undefined;
  /** Error message: replaces the hint, turns the control's border red and sets `aria-invalid`. */
  error?: string | undefined;
  /**
   * Shows a required marker after the label and sets `required` on the control.
   * @defaultValue false
   */
  required?: boolean | undefined;
  /** The control's `id`; generated when left out. Give it when the control has its own `id`. */
  htmlFor?: string | undefined;
  /** The control: Input, Textarea, Select, or a custom control reading `useFieldControl()`. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Label, hint and error around any form control. It gives the control its `id`, links the hint or
 * error with `aria-describedby` and sets `aria-invalid` on error. Input, Textarea and Select take
 * `label`/`hint`/`error` themselves; use Field to wrap other controls or to lay them out yourself.
 *
 * Without a label, hint or error, inside another Field, it passes that Field's wiring through and
 * renders no box of its own.
 *
 * @example
 * <Field label="Email" hint="Used for sign-in" required>
 *   <Input type="email" />
 * </Field>
 */
export function Field({ label, hint, error, required = false, htmlFor, children, className }: FieldProps) {
  const parent = use(FieldContext);
  const generatedId = useId();
  const message = error ?? hint;
  const ownChrome = label !== undefined || message !== undefined;
  const messageId = `${generatedId}-message`;

  const context: FieldControlProps =
    !ownChrome && parent !== null
      ? { ...parent, id: htmlFor ?? parent.id, required: required || parent.required }
      : {
          id: htmlFor ?? generatedId,
          describedBy: message === undefined ? undefined : messageId,
          invalid: error !== undefined,
          required,
        };

  return (
    <FieldContext value={context}>
      <div className={cn(ownChrome ? "flex min-w-0 flex-col gap-1.5" : "contents", className)}>
        {label !== undefined && (
          <label htmlFor={context.id} className="type-label text-fg-1">
            {label}
            {required && (
              <span aria-hidden="true" className="ml-0.5 text-danger-fg">
                *
              </span>
            )}
          </label>
        )}
        {children}
        {message !== undefined && (
          <p id={messageId} className={cn("m-0 type-caption", error === undefined ? "text-fg-3" : "text-danger-fg")}>
            {message}
          </p>
        )}
      </div>
    </FieldContext>
  );
}
