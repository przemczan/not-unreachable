import { useEffect, useId, useRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const boxClasses = [
  "h-control-lg w-10 min-w-0 rounded-control border border-solid border-border-control bg-surface p-0 text-center",
  "type-section-title tabular-nums text-fg-1 shadow-control outline-none",
  "transition duration-fast ease-out focus:border-border-focus focus:shadow-focus",
  "aria-invalid:border-danger aria-invalid:focus:border-danger",
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60",
];

export interface CodeInputProps {
  /** The digits entered so far, controlled: at most `length` of them, with no gaps. */
  value: string;
  /** Called with the new digits on every change. */
  onChange: (value: string) => void;
  /** Called once all `length` digits are entered, by typing or pasting. */
  onComplete?: (value: string) => void;
  /** The visible label; it names the group of boxes. Without it, give an `aria-label`. */
  label?: string;
  /** Names the group when there is no visible `label`. */
  "aria-label"?: string;
  /** Helper text under the boxes, linked with `aria-describedby`. */
  hint?: string;
  /** Error message: turns the borders red, replaces the hint and sets `aria-invalid`. */
  error?: string;
  /**
   * How many digits the code has.
   * @defaultValue 6
   */
  length?: number;
  /** @defaultValue false */
  disabled?: boolean;
  /**
   * Focuses the first empty box on mount, for a screen or a Dialog that asks for nothing else.
   * @defaultValue false
   */
  focusOnMount?: boolean;
  /** Classes for the wrapper. */
  className?: string;
  /** The first box, for a Dialog's `initialFocus`. */
  ref?: React.Ref<HTMLInputElement>;
}

const digitsOf = (text: string): string => text.replaceAll(/\D/g, "");

/**
 * A one-time code as a row of single-digit boxes, such as the 6 digits of an authenticator app.
 * Typing moves to the next box and Backspace to the previous one; pasting or autofilling the
 * whole code (with or without spaces) anywhere fills every box. The first box takes the browser's
 * `one-time-code` autofill. Each box is named "Digit 2 of 6"; the label names the group.
 *
 * @example
 * <CodeInput label="Authenticator code" value={code} onChange={setCode} hint="The 6-digit code from your app." />
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  label,
  "aria-label": ariaLabel,
  hint,
  error,
  length = 6,
  disabled = false,
  focusOnMount = false,
  className,
  ref,
}: CodeInputProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const messageId = `${id}-message`;
  const message = error ?? hint;
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const digits = digitsOf(value).slice(0, length);

  // Once, on mount; not again when the code is cleared after a wrong one.
  const focusedOnMount = useRef(false);
  useEffect(() => {
    if (!focusOnMount || focusedOnMount.current) return;
    focusedOnMount.current = true;
    boxes.current[Math.min(digits.length, length - 1)]?.focus();
  }, [focusOnMount, digits.length, length]);

  const focusBox = (index: number) => {
    const box = boxes.current[Math.max(0, Math.min(index, length - 1))];
    box?.focus();
    box?.select();
  };

  // Focus moves inside a change, before the new value renders: the focus check reads this instead.
  const latest = useRef(digits);
  useEffect(() => {
    latest.current = digits;
  });

  const write = (next: string) => {
    latest.current = next;
    onChange(next);
    if (next.length === length && next !== digits) onComplete?.(next);
  };

  const change = (index: number, event: React.ChangeEvent<HTMLInputElement>) => {
    const typed = digitsOf(event.target.value);
    if (typed === "") {
      write(digits.slice(0, index) + digits.slice(index + 1));
      return;
    }
    // A box selects its digit on focus, so typing replaces it; more than one digit is a paste or an autofill.
    const start = typed.length >= length ? 0 : index;
    const next = (digits.slice(0, start) + typed + digits.slice(start + typed.length)).slice(0, length);
    write(next);
    focusBox(start + typed.length);
  };

  const keyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && (digits[index] ?? "") === "" && index > 0) {
      event.preventDefault();
      write(digits.slice(0, index - 1) + digits.slice(index));
      focusBox(index - 1);
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === "ArrowRight" && index < digits.length) {
      event.preventDefault();
      focusBox(index + 1);
    }
  };

  // The digits have no gaps: a box past the first empty one sends focus back to it.
  const focus = (index: number, event: React.FocusEvent<HTMLInputElement>) => {
    if (index > latest.current.length) focusBox(latest.current.length);
    else event.target.select();
  };

  const setBox = (index: number) => (node: HTMLInputElement | null) => {
    boxes.current[index] = node;
    if (index !== 0) return;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <fieldset
      aria-labelledby={label != null ? labelId : undefined}
      aria-label={label == null ? ariaLabel : undefined}
      aria-describedby={message === undefined ? undefined : messageId}
      disabled={disabled}
      className={cn("m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0", className)}
    >
      {label != null && (
        <span id={labelId} className="type-label text-fg-1">
          {label}
        </span>
      )}
      <div className="flex gap-2">
        {Array.from({ length }, (_, index) => (
          <input
            // The boxes are positions, never reordered.
            key={index}
            ref={setBox(index)}
            type="text"
            inputMode="numeric"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            aria-label={`Digit ${index + 1} of ${length}`}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={message === undefined ? undefined : messageId}
            disabled={disabled}
            value={digits[index] ?? ""}
            onChange={(event) => change(index, event)}
            onKeyDown={(event) => keyDown(index, event)}
            onFocus={(event) => focus(index, event)}
            className={cn(boxClasses)}
          />
        ))}
      </div>
      {message !== undefined && (
        <p id={messageId} className={cn("m-0 type-caption", error === undefined ? "text-fg-3" : "text-danger-fg")}>
          {message}
        </p>
      )}
    </fieldset>
  );
}
