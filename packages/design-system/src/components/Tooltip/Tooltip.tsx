import { cva } from "class-variance-authority";
import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import { toCssLength } from "../../lib/toCssLength.ts";

/** The gap between the trigger and the tooltip, in px. */
const GAP = 6;

type Side = "top" | "bottom" | "left" | "right";

/** Anchors the tooltip's box at the measured point: centred on the trigger's side, outside it. */
const tooltipVariants = cva(
  [
    "fixed inset-auto top-(--nu-tooltip-y) left-(--nu-tooltip-x) z-tooltip m-0 overflow-visible",
    "pointer-events-none whitespace-nowrap rounded-badge border-0 bg-surface-inverse px-2 py-1.25 type-caption text-fg-inverse shadow-raised",
  ],
  {
    variants: {
      side: {
        top: "-translate-x-1/2 -translate-y-full",
        bottom: "-translate-x-1/2",
        left: "-translate-x-full -translate-y-1/2",
        right: "-translate-y-1/2",
      },
    },
  },
);

/** The point the tooltip is anchored at, per side: the middle of the trigger's side, GAP outside it. */
const anchors: Record<Side, (rect: DOMRect) => { x: number; y: number }> = {
  top: (rect) => ({ x: rect.left + rect.width / 2, y: rect.top - GAP }),
  bottom: (rect) => ({ x: rect.left + rect.width / 2, y: rect.bottom + GAP }),
  left: (rect) => ({ x: rect.left - GAP, y: rect.top + rect.height / 2 }),
  right: (rect) => ({ x: rect.right + GAP, y: rect.top + rect.height / 2 }),
};

export interface TooltipProps {
  /** The hint: a few words. */
  content: React.ReactNode;
  /**
   * The side of the trigger it shows on.
   * @defaultValue "top"
   */
  side?: Side;
  /** The trigger: a focusable element, which gets `aria-describedby` pointing at the tooltip. */
  children: React.ReactNode;
  /** Forces it open (docs and previews); left out, it follows hover and focus. */
  open?: boolean;
}

/**
 * A short hint on hover and keyboard focus: labels icon-only buttons, explains truncated values or
 * metric definitions. It is a native `popover="manual"` (it never takes focus), and hides on blur,
 * mouse leave and Escape.
 *
 * @example
 * <Tooltip content="Export CSV">
 *   <IconButton label="Export" icon={<Icon name="download" />} />
 * </Tooltip>
 */
export function Tooltip({ content, side = "top", children, open: forced }: TooltipProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const open = forced ?? shown;

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const wrapper = wrapperRef.current;
    if (!tooltip || !wrapper) return;
    if (open) {
      setAnchor(anchors[side](wrapper.getBoundingClientRect()));
      tooltip.showPopover();
    } else {
      tooltip.hidePopover();
    }
  }, [open, side]);

  useEffect(() => {
    if (!open || forced !== undefined) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShown(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, forced]);

  const trigger = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" ") })
    : children;

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex"
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
    >
      {trigger}
      <span
        ref={tooltipRef}
        id={id}
        role="tooltip"
        popover="manual"
        className={tooltipVariants({ side })}
        style={{ "--nu-tooltip-x": toCssLength(anchor.x), "--nu-tooltip-y": toCssLength(anchor.y) }}
      >
        {/* type-caption sets the size; the weight goes on the text, as the font shorthand would override it. */}
        <span className="font-medium">{content}</span>
      </span>
    </span>
  );
}
