import { cva } from "class-variance-authority";
import { useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { toCssLength } from "../../lib/toCssLength.ts";
import { useModalDialog } from "../../lib/useModalDialog.ts";
import { Icon } from "../Icon/index.ts";
import { IconButton } from "../IconButton/index.ts";

const drawerVariants = cva("flex-col bg-surface-raised text-fg-1", {
  variants: {
    inline: {
      // `open:flex`, never `flex`: a display class would show the closed dialog.
      false: [
        "fixed inset-y-0 right-0 left-auto m-0 h-full max-h-full w-(--nu-drawer-w) max-w-full open:flex",
        "border-0 border-l border-solid border-border shadow-floating",
        "transition duration-slow ease-out starting:open:translate-x-6 starting:open:opacity-0",
      ],
      true: "flex h-full w-(--nu-drawer-w) max-w-full border-l border-solid border-border",
    },
  },
});

export interface DrawerProps {
  /**
   * Shown as a modal side panel while true. Like Dialog, it never closes itself: Escape, the close
   * button and a click on the backdrop call `onClose`.
   * @defaultValue true
   */
  open?: boolean;
  /** The heading; it names the drawer (`aria-labelledby`). */
  title?: React.ReactNode;
  /** A line under the title, such as the record's time and ID; it describes the drawer. */
  description?: React.ReactNode;
  /** The scrolling body. */
  children?: React.ReactNode;
  /** Footer actions, right-aligned on a sunken strip that stays at the bottom. */
  footer?: React.ReactNode;
  /** Called on Escape, the close button and a click on the backdrop; without it there is no close button. */
  onClose?: () => void;
  /**
   * Width in px, at most the viewport.
   * @defaultValue 480
   */
  width?: number;
  /**
   * Renders the panel in place as an `<aside>`, without the modal and its overlay.
   * @defaultValue false
   */
  inline?: boolean;
  /** Classes for the panel. */
  className?: string;
}

/**
 * A side panel from the right for a record's details or a longer form, on the native `<dialog>`
 * and `showModal()` like Dialog: focus stays inside, the page behind is inert, Escape closes. It
 * slides in 24px and fades over 280ms (none with reduced motion). The content renders only while
 * open.
 *
 * @example
 * <Drawer open={event !== null} onClose={() => setEvent(null)} title="Session signed out" description="20 Oct, 14:02 UTC · evt_10482">
 *   <DescriptionList items={fields} />
 * </Drawer>
 */
export function Drawer({
  open = true,
  title,
  description,
  children,
  footer,
  onClose,
  width = 480,
  inline = false,
  className,
}: DrawerProps) {
  const titleId = useId();
  const descriptionId = useId();
  const { ref, handlers } = useModalDialog(open && !inline, onClose);
  const labels = {
    "aria-labelledby": title != null ? titleId : undefined,
    "aria-describedby": description != null ? descriptionId : undefined,
  };

  const content = (
    <>
      <header className="flex flex-none items-start gap-3 border-b border-solid border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          {title != null && (
            <h2 id={titleId} className="m-0 type-section-title text-fg-1">
              {title}
            </h2>
          )}
          {description != null && (
            <p id={descriptionId} className="m-0 mt-0.5 type-body-sm text-fg-3">
              {description}
            </p>
          )}
        </div>
        {onClose && <IconButton label="Close" size="sm" icon={<Icon name="x" />} onClick={onClose} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      {footer != null && (
        <footer className="flex flex-none justify-end gap-2 border-t border-solid border-border bg-surface-sunken px-5 py-3">
          {footer}
        </footer>
      )}
    </>
  );

  if (inline) {
    return (
      <aside {...labels} style={{ "--nu-drawer-w": toCssLength(width) }} className={cn(drawerVariants({ inline }), className)}>
        {content}
      </aside>
    );
  }

  return (
    // The dialog takes Escape natively (as `cancel`); the click only catches the backdrop.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      {...labels}
      {...handlers}
      style={{ "--nu-drawer-w": toCssLength(width) }}
      className={cn(drawerVariants({ inline }), className)}
    >
      {open && content}
    </dialog>
  );
}
