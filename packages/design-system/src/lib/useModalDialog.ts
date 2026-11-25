import { useLayoutEffect, useRef } from "react";
import type * as React from "react";

/** The handlers a modal `<dialog>` needs; spread them on it with the ref. */
export interface ModalDialogHandlers {
  onCancel: (event: React.SyntheticEvent<HTMLDialogElement>) => void;
  onClose: (event: React.SyntheticEvent<HTMLDialogElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDialogElement>) => void;
  onClick: (event: React.MouseEvent<HTMLDialogElement>) => void;
}

/**
 * Whether a pointer event hit the dialog's backdrop. The backdrop belongs to the `<dialog>`, so a
 * click there targets the dialog itself; so does one on a gap between the panel's parts, which only
 * the dialog's box tells apart.
 */
function isOnBackdrop(event: React.MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false;
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}

/**
 * Drives a native `<dialog>` from an `open` prop with `showModal()` / `close()`, so the browser
 * traps focus, makes the page behind inert, puts the dialog in the top layer and turns Escape into
 * a `cancel` event. The open state stays the caller's: Escape and a click on the backdrop call
 * `onClose` (the caller then sets `open` to false); the dialog never closes itself.
 *
 * `initialFocus` gets the focus once the dialog opens; without it, the browser focuses the first
 * focusable element. React's `autoFocus` can't choose it: React focuses the element before the
 * dialog is shown, when it can't take focus yet.
 */
export function useModalDialog(open: boolean, onClose: (() => void) | undefined, initialFocus?: React.RefObject<HTMLElement | null>) {
  const ref = useRef<HTMLDialogElement>(null);
  const latest = useRef({ open, onClose });
  const pressedOnBackdrop = useRef(false);

  useLayoutEffect(() => {
    // Updated first, so the `close` event `close()` fires below sees the new state.
    latest.current = { open, onClose };
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocus?.current?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open, onClose, initialFocus]);

  const handlers: ModalDialogHandlers = {
    // React passes a `cancel` or `close` of a dialog nested in this one (a Dialog over a Drawer) up
    // the component tree, though the browser doesn't bubble them: only this dialog's own count.
    onCancel: (event) => {
      if (event.target !== event.currentTarget) return;
      // Escape: let the caller decide. A browser may make a repeated Escape uncancelable and close
      // anyway; onClose below reports that one.
      if (!event.cancelable) return;
      event.preventDefault();
      latest.current.onClose?.();
    },
    onClose: (event) => {
      if (event.target !== event.currentTarget) return;
      // Closed by the browser (a form with method="dialog", a forced close request) while still open for the caller.
      if (latest.current.open) latest.current.onClose?.();
    },
    onPointerDown: (event) => {
      pressedOnBackdrop.current = isOnBackdrop(event);
    },
    onClick: (event) => {
      // Pressed and released on the backdrop: a drag that starts in a field and ends outside doesn't close it.
      const pressed = pressedOnBackdrop.current;
      pressedOnBackdrop.current = false;
      if (pressed && isOnBackdrop(event)) latest.current.onClose?.();
    },
  };

  return { ref, handlers };
}
