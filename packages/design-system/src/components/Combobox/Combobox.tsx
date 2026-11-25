import { cva } from "class-variance-authority";
import { useEffect, useId, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Input, type InputProps } from "../Input/index.ts";

/** Under the input's box, as wide as it: the box is the list's positioned ancestor. */
const listboxClasses = [
  "absolute top-full right-0 left-0 z-dropdown m-0 mt-1 max-h-64 list-none overflow-y-auto",
  "rounded-card border border-solid border-border bg-surface-raised p-1 text-fg-1 shadow-floating",
];

const optionVariants = cva(
  "flex h-8 cursor-pointer items-center gap-2 rounded-badge px-2.5 type-body-sm text-fg-1 hover:bg-control-hover",
  {
    variants: {
      active: {
        true: "bg-control-hover",
        false: "",
      },
    },
  },
);

export interface ComboboxOption {
  /** What choosing the option puts in the input, and its key. */
  value: string;
  /** What the list shows; the value when left out. */
  label?: React.ReactNode;
}

export interface ComboboxProps extends Omit<InputProps, "onSelect" | "value" | "role"> {
  /** The input's text; the Combobox is always controlled, as any text is allowed. */
  value: string;
  /** The suggestions shown under the input, in order; already filtered by the caller. */
  options: readonly ComboboxOption[];
  /** Called with the option chosen by click or Enter; the caller puts it in `value`. */
  onSelect: (value: string) => void;
  /** Shows a loading row in the list while the options are on their way. */
  loading?: boolean;
  /**
   * The loading row's text.
   * @defaultValue "Loading…"
   */
  loadingLabel?: string;
  /**
   * Closes the list once an option is chosen; set to false when choosing leads to new options,
   * such as a folder's subfolders.
   * @defaultValue true
   */
  closeOnSelect?: boolean;
}

/**
 * A text input with a list of suggestions under it, by the WAI-ARIA 1.2 combobox pattern with list
 * autocomplete: any text is allowed and the list only helps. Typing or ArrowDown opens the list,
 * ArrowDown and ArrowUp move through the options (wrapping), Enter or a click chooses one, Escape
 * closes the list, and Tab leaves without choosing. Focus stays in the input throughout.
 *
 * @example
 * <Combobox
 *   label="Folder"
 *   value={folder}
 *   onChange={(event) => setFolder(event.target.value)}
 *   options={folders.map((name) => ({ value: name }))}
 *   onSelect={setFolder}
 * />
 */
export function Combobox({
  value,
  options,
  onSelect,
  loading = false,
  loadingLabel = "Loading…",
  closeOnSelect = true,
  className,
  suffix,
  onChange,
  onKeyDown,
  onBlur,
  ...rest
}: ComboboxProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const expanded = open && (options.length > 0 || loading);
  const optionId = (index: number): string => `${listboxId}-option-${String(index)}`;

  // Other options (another prefix, another folder) make the active position meaningless; the same
  // options in a new array, as a caller's re-render makes, keep it.
  const optionValues = options.map((option) => option.value).join("\n");
  const [shownValues, setShownValues] = useState(optionValues);
  if (shownValues !== optionValues) {
    setShownValues(optionValues);
    setActiveIndex(-1);
  }

  useEffect(() => {
    if (activeIndex < 0) return;
    const active = document.getElementById(`${listboxId}-option-${String(activeIndex)}`);
    // jsdom has no scrollIntoView.
    if (typeof active?.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listboxId]);

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const choose = (option: ComboboxOption) => {
    onSelect(option.value);
    if (closeOnSelect) close();
    else setActiveIndex(-1);
  };

  const move = (step: 1 | -1) => {
    if (options.length === 0) return;
    setActiveIndex((current) => {
      if (current < 0) return step === 1 ? 0 : options.length - 1;
      return (current + step + options.length) % options.length;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (open) move(event.key === "ArrowDown" ? 1 : -1);
        else setOpen(true);
        break;
      case "Enter": {
        const active = expanded ? options[activeIndex] : undefined;
        if (active === undefined) return;
        // Choosing an option, not submitting the form around the input.
        event.preventDefault();
        choose(active);
        break;
      }
      case "Escape":
        if (!expanded) return;
        // Closes the list only, not a dialog or drawer the field sits in.
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      default:
    }
  };

  const listbox = (
    // The input keeps focus and handles the keys (aria-activedescendant), so the list needs neither.
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
    <ul id={listboxId} role="listbox" aria-busy={loading} hidden={!expanded} className={cn(listboxClasses)}>
      {options.map((option, index) => (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
        <li
          key={option.value}
          id={optionId(index)}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
          role="option"
          aria-selected={index === activeIndex}
          className={optionVariants({ active: index === activeIndex })}
          // Keeps focus in the input, so the list stays open and the caret stays put.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(option)}
        >
          <span className="min-w-0 truncate">{option.label ?? option.value}</span>
        </li>
      ))}
      {loading && (
        <li role="presentation" className="flex h-8 items-center px-2.5 type-body-sm text-fg-3">
          {loadingLabel}
        </li>
      )}
    </ul>
  );

  return (
    <Input
      {...rest}
      className={cn("relative", className)}
      value={value}
      // A text input that controls a listbox: the ARIA combobox role, which no native element has.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="combobox"
      autoComplete="off"
      aria-autocomplete="list"
      aria-expanded={expanded}
      aria-controls={listboxId}
      aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      suffix={
        <>
          {suffix}
          {listbox}
        </>
      }
      onChange={(event) => {
        onChange?.(event);
        setOpen(true);
      }}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        onBlur?.(event);
        close();
      }}
    />
  );
}
