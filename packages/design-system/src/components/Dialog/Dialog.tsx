import { useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { toCssLength } from "../../lib/toCssLength.ts";
import { useModalDialog } from "../../lib/useModalDialog.ts";
import { Icon } from "../Icon/index.ts";
import { IconButton } from "../IconButton/index.ts";

const panelClasses =
  "w-(--nu-dialog-w) overflow-hidden rounded-dialog border border-solid border-border bg-surface-raised text-fg-1 shadow-floating";

export interface DialogProps {
  /**
   * Shown as a modal while true. The dialog never closes itself: Escape, the close button and a
   * click on the backdrop call `onClose`, and the caller sets `open` to false.
   * @defaultValue true
   */
  open?: boolean;
  /** The heading; it names the dialog (`aria-labelledby`). A confirm asks a question naming the object: "Sign out this session?". */
  title?: React.ReactNode;
  /** The consequence and the way back, under the title; it describes the dialog (`aria-describedby`). */
  description?: React.ReactNode;
  /** The body: a short form or more detail. */
  children?: React.ReactNode;
  /** Footer buttons, right-aligned on a sunken strip: secondary first, primary or danger last. */
  actions?: React.ReactNode;
  /** Called on Escape, the close button and a click on the backdrop; without it the dialog has no close button. */
  onClose?: () => void;
  /** The element focused when the dialog opens, such as the field it asks for; the first focusable element when left out. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /**
   * Width in px, at most the viewport less 2rem.
   * @defaultValue 480
   */
  width?: number;
  /** `danger` adds a warning glyph, for destructive confirmations. */
  tone?: "danger";
  /**
   * Renders the panel in place as a `<section>`, without the modal and its overlay (documentation, previews).
   * @defaultValue false
   */
  inline?: boolean;
  /** Classes for the panel. */
  className?: string;
}

/**
 * A modal dialog for confirmations and short forms, on the native `<dialog>` and `showModal()`:
 * the browser keeps focus inside it, makes the page behind inert and turns Escape into a close
 * request. Focus moves to the first focusable element (pass `initialFocus` to choose another) and
 * returns to the opener on close. The content renders only while open.
 *
 * @example
 * <Dialog
 *   open={confirming}
 *   onClose={() => setConfirming(false)}
 *   title="Sign out this session?"
 *   description="The device has to sign in again to use NotUnreachable."
 *   actions={<><Button variant="secondary" onClick={cancel}>Cancel</Button><Button variant="danger" onClick={signOut}>Sign out session</Button></>}
 * />
 */
export function Dialog({
  open = true,
  title,
  description,
  children,
  actions,
  onClose,
  initialFocus,
  width = 480,
  tone,
  inline = false,
  className,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const { ref, handlers } = useModalDialog(open && !inline, onClose, initialFocus);
  const labels = {
    "aria-labelledby": title != null ? titleId : undefined,
    "aria-describedby": description != null ? descriptionId : undefined,
  };

  const content = (
    <>
      <div className="flex items-start gap-3 px-5 pt-5">
        {tone === "danger" && (
          <span className="grid size-8 flex-none place-items-center rounded-full bg-danger-subtle text-danger-fg">
            <Icon name="triangle-alert" size={16} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {title != null && (
            <h2 id={titleId} className="m-0 type-section-title text-fg-1">
              {title}
            </h2>
          )}
          {description != null && (
            <p id={descriptionId} className="m-0 mt-1 type-body text-fg-2">
              {description}
            </p>
          )}
        </div>
        {onClose && <IconButton label="Close" size="sm" icon={<Icon name="x" />} onClick={onClose} className="-mt-1 -mr-1.5" />}
      </div>
      {children != null && <div className="px-5 pt-4">{children}</div>}
      {actions != null ? (
        <div className="mt-5 flex justify-end gap-2 border-t border-solid border-border bg-surface-sunken px-5 py-4">{actions}</div>
      ) : (
        <div className="h-5" />
      )}
    </>
  );

  if (inline) {
    return (
      <section {...labels} style={{ "--nu-dialog-w": toCssLength(width) }} className={cn(panelClasses, "max-w-full", className)}>
        {content}
      </section>
    );
  }

  return (
    // The dialog takes Escape natively (as `cancel`); the click only catches the backdrop.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog ref={ref} {...labels} {...handlers} style={{ "--nu-dialog-w": toCssLength(width) }} className={cn(panelClasses, className)}>
      {open && content}
    </dialog>
  );
}
