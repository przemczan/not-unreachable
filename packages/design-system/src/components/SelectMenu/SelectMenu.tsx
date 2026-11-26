import { cva } from "class-variance-authority";
import { useEffect, useId, useRef, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Field, joinIds, useFieldControl } from "../Field/index.ts";
import { Icon } from "../Icon/index.ts";

/** How long typed characters keep adding to one type-ahead search, in ms. */
const TYPE_AHEAD_RESET_MS = 500;

const triggerVariants = cva(
  [
    "flex w-full cursor-pointer items-center rounded-control border border-solid border-border-control bg-surface pr-8 pl-2.5 text-left text-fg-1 shadow-control outline-none",
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

/** Under the trigger, at least as wide as it and at most 24rem: the wrapper is its positioned ancestor. */
const listboxClasses = [
  "absolute top-full left-0 z-dropdown m-0 mt-1 max-h-64 w-max max-w-96 min-w-full list-none overflow-y-auto",
  "rounded-card border border-solid border-border bg-surface-raised p-1 text-fg-1 shadow-floating",
];

const optionVariants = cva("flex min-h-8 cursor-pointer items-center gap-2 rounded-badge px-2.5 py-1.5 hover:bg-control-hover", {
  variants: {
    active: {
      true: "bg-control-hover",
      false: "",
    },
  },
});

/** One option of a SelectMenu. */
export interface SelectMenuOption {
  value: string;
  /** What the trigger and the list show. */
  label: string;
  /** A second, muted line under the label in the list only. */
  description?: string;
}

export interface SelectMenuProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "defaultValue" | "onChange" | "type" | "children" | "role"
> {
  /** The visible label; with `label`, `hint` or `error` the menu is wrapped in a Field. */
  label?: string;
  /** Helper text under the trigger, linked with `aria-describedby`. */
  hint?: string;
  /** Error message: turns the border red, replaces the hint and sets `aria-invalid`. */
  error?: string;
  /** Marks the label required and sets `aria-required`. */
  required?: boolean | undefined;
  /** The options, in order. */
  options: readonly SelectMenuOption[];
  /** The selected value; the SelectMenu is always controlled. */
  value: string;
  /** Called with the value of the option chosen, when it is another one. */
  onChange: (value: string) => void;
  /** Shown, muted, while `value` matches no option. */
  placeholder?: string;
  /**
   * Height: `sm` 28px, `md` 32px, `lg` 40px.
   * @defaultValue "md"
   */
  size?: "sm" | "md" | "lg";
  /** @defaultValue false */
  disabled?: boolean;
  /** The trigger's `id`; generated when left out. */
  id?: string;
  /** Classes for the wrapper around the trigger and the list (width, margins). */
  className?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

type SelectMenuControlProps = Omit<SelectMenuProps, "label" | "hint" | "error" | "id">;

/** The first option, from `from` on and wrapping, whose label starts with `query`; -1 for none. */
function findByLabel(options: readonly SelectMenuOption[], query: string, from: number): number {
  const wanted = query.toLowerCase();
  for (let step = 0; step < options.length; step += 1) {
    const index = (from + step) % options.length;
    if (options[index]?.label.toLowerCase().startsWith(wanted)) return index;
  }
  return -1;
}

/** Whether the key types a character (not a shortcut), so it searches the labels. */
function isTypeAheadKey(event: React.KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** The type-ahead buffer: characters typed in quick succession form one search. */
function useTypeAhead() {
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    /** Adds the character and returns the whole search. */
    add(character: string): string {
      clearTimeout(timer.current);
      buffer.current += character;
      timer.current = setTimeout(() => {
        buffer.current = "";
      }, TYPE_AHEAD_RESET_MS);
      return buffer.current;
    },
    /** True while a search is going on, when Space is part of it rather than a choice. */
    isTyping: () => buffer.current !== "",
  };
}

function SelectMenuControl({
  options,
  value,
  onChange,
  placeholder,
  size = "md",
  disabled = false,
  required,
  className,
  ref,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  onClick,
  onKeyDown,
  onBlur,
  ...rest
}: SelectMenuControlProps) {
  const field = useFieldControl();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const typeAhead = useTypeAhead();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const active = activeIndex < options.length ? activeIndex : -1;
  const optionId = (index: number): string => `${listboxId}-option-${String(index)}`;

  useEffect(() => {
    if (!open || active < 0) return;
    const element = document.getElementById(`${listboxId}-option-${String(active)}`);
    // jsdom has no scrollIntoView.
    if (typeof element?.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
  }, [open, active, listboxId]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const openAt = (index: number) => {
    if (options.length === 0) return;
    setActiveIndex(index);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option !== undefined && option.value !== value) onChange(option.value);
    close();
    triggerRef.current?.focus();
  };

  const search = (character: string) => {
    const query = typeAhead.add(character);
    const from = open ? active : selectedIndex;
    // Repeating one character cycles through the labels that start with it.
    const cycling = query === character.repeat(query.length);
    const found = cycling ? findByLabel(options, character, from + 1) : findByLabel(options, query, Math.max(from, 0));
    if (found >= 0) openAt(found);
    else if (!open) openAt(Math.max(selectedIndex, 0));
  };

  const keyWhenClosed = (event: React.KeyboardEvent<HTMLButtonElement>): boolean => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        openAt(Math.max(selectedIndex, 0));
        return true;
      case "Home":
        openAt(0);
        return true;
      case "End":
        openAt(options.length - 1);
        return true;
      default:
        if (!isTypeAheadKey(event)) return false;
        search(event.key);
        return true;
    }
  };

  const keyWhenOpen = (event: React.KeyboardEvent<HTMLButtonElement>): boolean => {
    const last = options.length - 1;
    switch (event.key) {
      case "ArrowDown":
        setActiveIndex(Math.min(active + 1, last));
        return true;
      case "ArrowUp":
        setActiveIndex(active < 0 ? last : Math.max(active - 1, 0));
        return true;
      case "Home":
        setActiveIndex(0);
        return true;
      case "End":
        setActiveIndex(last);
        return true;
      case " ":
        if (typeAhead.isTyping()) search(" ");
        else choose(active);
        return true;
      case "Enter":
        choose(active);
        return true;
      case "Escape":
        // Closes the list only, not a dialog or drawer the menu sits in.
        event.stopPropagation();
        close();
        return true;
      case "Tab":
        close();
        return false;
      default:
        if (!isTypeAheadKey(event)) return false;
        search(event.key);
        return true;
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    // Handled keys never reach the button's own behaviour: Enter and Space would click it.
    if (open ? keyWhenOpen(event) : keyWhenClosed(event)) event.preventDefault();
  };

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        ref={(element) => {
          triggerRef.current = element;
          if (typeof ref === "function") return ref(element);
          if (ref) ref.current = element;
          return undefined;
        }}
        type="button"
        id={field?.id}
        disabled={disabled}
        // A button that controls a listbox: the ARIA combobox role, which no native element has.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-required={(required ?? field?.required) === true ? true : undefined}
        aria-describedby={joinIds(field?.describedBy, ariaDescribedBy)}
        aria-invalid={ariaInvalid ?? (field?.invalid === true ? true : undefined)}
        className={triggerVariants({ size })}
        {...rest}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          if (open) close();
          else openAt(Math.max(selectedIndex, 0));
        }}
        onKeyDown={handleKeyDown}
        // Firefox clicks a button on Space's keyup: the keydown already handled it.
        onKeyUp={(event) => {
          if (event.key === " ") event.preventDefault();
        }}
        onBlur={(event) => {
          onBlur?.(event);
          close();
        }}
      >
        {selected === undefined ? (
          <span className="min-w-0 truncate text-fg-3">{placeholder}</span>
        ) : (
          <span className="min-w-0 truncate" title={selected.label}>
            {selected.label}
          </span>
        )}
      </button>
      <Icon name="chevron-down" size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-3" />
      {/* The trigger keeps focus and handles the keys (aria-activedescendant), so the list needs neither. */}
      <ul
        id={listboxId}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
        role="listbox"
        hidden={!open}
        className={cn(listboxClasses)}
        // Keeps focus on the trigger, so the list stays open, also when its scrollbar is dragged.
        onMouseDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => (
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
          <li
            key={option.value}
            id={optionId(index)}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
            role="option"
            aria-selected={index === active}
            className={optionVariants({ active: index === active })}
            onClick={() => choose(index)}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate type-body-sm text-fg-1" title={option.label}>
                {option.label}
              </span>
              {option.description !== undefined && (
                <span className="truncate type-caption text-fg-3" title={option.description}>
                  {option.description}
                </span>
              )}
            </span>
            <span className="grid w-3.5 flex-none text-accent">{index === selectedIndex && <Icon name="check" size={14} />}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A dropdown of options with a label and an optional description each, by the WAI-ARIA 1.2
 * select-only combobox pattern: a button showing the chosen option's label, opening a listbox under
 * it. Use it over Select when the options need a second line. Click, Enter, Space or the arrow keys
 * open it at the chosen option; the arrow keys, Home, End and typing a label's start move through
 * the options; Enter, Space or a click chooses one and closes it; Escape, Tab or a click outside
 * closes it without choosing. Focus stays on the trigger throughout.
 *
 * @example
 * <SelectMenu
 *   label="Resource"
 *   value={resourceId}
 *   onChange={setResourceId}
 *   options={[{ value: "media", label: "Media", description: "Local folder · /srv/media" }]}
 * />
 */
export function SelectMenu({ label, hint, error, required, id, ...rest }: SelectMenuProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <SelectMenuControl required={required} {...rest} />
    </Field>
  );
}
