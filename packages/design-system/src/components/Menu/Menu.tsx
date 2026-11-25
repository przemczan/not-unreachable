import { cva } from "class-variance-authority";
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { toCssLength } from "../../lib/toCssLength.ts";

/** The gap between the trigger and the menu, in px. */
const GAP = 4;

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The items the arrow keys move between: every menuitem but the disabled ones. */
function enabledItemsOf(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
}

/** The props the menu reads on, or adds to, its trigger. */
interface TriggerProps {
  id?: string;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
}

const menuVariants = cva(
  [
    "fixed inset-auto top-(--nu-menu-y) left-(--nu-menu-x) z-dropdown m-0 w-(--nu-menu-w) overflow-visible",
    "rounded-card border border-solid border-border bg-surface-raised p-1 text-fg-1 shadow-floating",
  ],
  {
    variants: {
      align: {
        start: "",
        end: "-translate-x-full",
      },
    },
  },
);

const itemVariants = cva(
  [
    "flex h-8 w-full cursor-pointer items-center gap-2 rounded-badge border-0 bg-transparent px-2.5 text-left type-body-sm outline-none",
    "disabled:cursor-not-allowed disabled:text-fg-disabled",
  ],
  {
    variants: {
      danger: {
        true: "text-danger-fg focus:bg-danger-subtle enabled:hover:bg-danger-subtle",
        false: "text-fg-1 focus:bg-control-hover enabled:hover:bg-control-hover",
      },
    },
  },
);

export interface MenuItem {
  /** The item's text. */
  label?: React.ReactNode;
  /** A leading icon, usually `<Icon size={14} />`. */
  icon?: React.ReactNode;
  /** A keyboard hint shown at the right, such as `"⌘E"`; display only. */
  shortcut?: string;
  /** Destructive: danger-coloured text and hover. */
  danger?: boolean;
  /** Shown, but skipped by the arrow keys and not selectable. */
  disabled?: boolean;
  /** Called when the item is chosen; the menu then closes. */
  onSelect?: () => void;
  /** Renders a separator instead of an item. */
  divider?: boolean;
  /** Renders a small group heading instead of an item. */
  heading?: string;
}

export interface MenuProps {
  /** The element that toggles the menu, usually an IconButton or a Button. */
  trigger: React.ReactNode;
  /** The menu's items, separators and headings, in order. */
  items?: MenuItem[];
  /**
   * Which edge of the trigger the menu lines up with.
   * @defaultValue "end"
   */
  align?: "start" | "end";
  /**
   * The menu's width, in px.
   * @defaultValue 200
   */
  width?: number;
  /** Controls the open state; left out, the menu keeps its own. */
  open?: boolean;
  /** Called whenever the menu opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Classes for the wrapper around the trigger and the menu. */
  className?: string;
}

/**
 * A dropdown action menu: row "…" actions, the user menu, bulk actions. It is a native popover
 * placed under its trigger, a `role="menu"` of `menuitem`s: it opens on click, Enter, Space or
 * ArrowDown (ArrowUp opens at the last item), the arrow keys move between items (wrapping), Home and
 * End jump, Escape closes it and gives focus back to the trigger, and so does choosing an item. A
 * click outside or Tab closes it too.
 *
 * @example
 * <Menu
 *   trigger={<IconButton label="Actions" icon={<Icon name="more-horizontal" />} />}
 *   items={[{ label: "Edit", icon: <Icon name="pencil" size={14} /> }, { divider: true }, { label: "Delete", danger: true }]}
 * />
 */
export function Menu({ trigger, items = [], align = "end", width = 200, open: controlled, onOpenChange, className }: MenuProps) {
  const menuId = useId();
  const triggerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<"first" | "last">("first");
  const [uncontrolled, setUncontrolled] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const open = controlled ?? uncontrolled;

  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (!returnFocus) return;
    const host = triggerRef.current;
    const target = host?.matches(FOCUSABLE) ? host : host?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const host = triggerRef.current;
    if (!menu || !host) return undefined;
    if (!open) {
      menu.hidePopover();
      return undefined;
    }
    const place = () => {
      const rect = host.getBoundingClientRect();
      setAnchor({ x: align === "end" ? rect.right : rect.left, y: rect.bottom + GAP });
    };
    place();
    menu.showPopover();
    const list = enabledItemsOf(menu);
    (focusOnOpen.current === "last" ? list.at(-1) : list[0])?.focus();
    focusOnOpen.current = "first";
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, triggerRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen]);

  const onTriggerClick = () => setOpen(!open);

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const edge = event.key === "ArrowDown" ? "first" : "last";
    if (open) {
      const list = enabledItemsOf(menuRef.current);
      (edge === "last" ? list.at(-1) : list[0])?.focus();
    } else {
      focusOnOpen.current = edge;
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const list = enabledItemsOf(menuRef.current);
    const current = list.findIndex((element) => element === document.activeElement);
    const focusAt = (index: number) => list[(index + list.length) % list.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        focusAt(current + 1);
        break;
      case "ArrowUp":
        focusAt(current < 0 ? -1 : current - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(-1);
        break;
      case "Escape":
        close(true);
        break;
      case "Tab":
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const triggerProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": menuId,
  };
  // The handlers sit on the presentational wrapper, which the trigger's events bubble to.
  const triggerElement = isValidElement<TriggerProps>(trigger) ? (
    cloneElement(trigger, { ...triggerProps, id: trigger.props.id ?? triggerId })
  ) : (
    // Text or a fragment: give it a button, so the menu always has a focusable trigger.
    <button type="button" id={triggerId} {...triggerProps}>
      {trigger}
    </button>
  );
  const labelledBy = isValidElement<TriggerProps>(trigger) ? (trigger.props.id ?? triggerId) : triggerId;

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <span ref={triggerRef} role="presentation" className="inline-flex" onClick={onTriggerClick} onKeyDown={onTriggerKeyDown}>
        {triggerElement}
      </span>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        tabIndex={-1}
        aria-labelledby={labelledBy}
        popover="manual"
        className={menuVariants({ align })}
        style={{
          "--nu-menu-x": toCssLength(anchor.x),
          "--nu-menu-y": toCssLength(anchor.y),
          "--nu-menu-w": toCssLength(width),
        }}
        onKeyDown={onMenuKeyDown}
      >
        {items.map((item, index) => {
          if (item.divider) return <hr key={index} className="my-1 border-border" />;
          if (item.heading)
            return (
              <div key={index} role="presentation" className="px-2.5 pt-1.5 pb-1 type-overline text-fg-3">
                {item.heading}
              </div>
            );
          return (
            <button
              key={index}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              className={itemVariants({ danger: item.danger ?? false })}
              onClick={() => {
                item.onSelect?.();
                close(true);
              }}
            >
              {item.icon != null && (
                <span aria-hidden="true" className={cn("grid", !item.danger && "text-fg-3")}>
                  {item.icon}
                </span>
              )}
              <span className="flex-1">{item.label}</span>
              {item.shortcut != null && (
                // type-caption sets the size; kbd keeps its mono family from the base styles.
                <span className="type-caption text-fg-3">
                  <kbd>{item.shortcut}</kbd>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
