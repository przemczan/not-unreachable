import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/** Fires a ToggleEvent-like event: an Event carrying `oldState` and `newState`. */
function dispatchToggle(element: HTMLElement, type: "beforetoggle" | "toggle", oldState: string, newState: string): boolean {
  const event = new Event(type, { cancelable: type === "beforetoggle" && newState === "open" });
  Object.assign(event, { oldState, newState });
  return element.dispatchEvent(event);
}

/**
 * jsdom has no Popover API: no `showPopover()`/`hidePopover()`/`togglePopover()`, and its default
 * stylesheet hides every `[popover]` because `:popover-open` never matches. This stub stands in for
 * it, only as far as the components' tests need:
 * - the open state is kept in a `data-popover-open` attribute (tests may read it);
 * - `beforetoggle` then `toggle` are dispatched with `oldState`/`newState`, like the browser's
 *   ToggleEvent (synchronously here; the browser queues `toggle`);
 * - a test-only rule shows open popovers, so Testing Library's visibility checks see them.
 * It doesn't model the top layer, light dismiss, or the InvalidStateError cases.
 * Node-environment tests (`// @vitest-environment node`) have no DOM, so nothing is stubbed there.
 */
if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover !== "function") {
  const OPEN = "data-popover-open";

  const setOpen = (element: HTMLElement, open: boolean): void => {
    if (!element.hasAttribute("popover") || element.hasAttribute(OPEN) === open) return;
    const [oldState, newState] = open ? ["closed", "open"] : ["open", "closed"];
    if (!dispatchToggle(element, "beforetoggle", oldState, newState)) return;
    element.toggleAttribute(OPEN, open);
    dispatchToggle(element, "toggle", oldState, newState);
  };

  Object.defineProperties(HTMLElement.prototype, {
    showPopover: {
      configurable: true,
      value(this: HTMLElement) {
        setOpen(this, true);
      },
    },
    hidePopover: {
      configurable: true,
      value(this: HTMLElement) {
        setOpen(this, false);
      },
    },
    togglePopover: {
      configurable: true,
      value(this: HTMLElement, force?: boolean) {
        const open = force ?? !this.hasAttribute(OPEN);
        setOpen(this, open);
        return open;
      },
    },
  });

  const sheet = document.createElement("style");
  sheet.textContent = `[popover][${OPEN}] { display: block; }`;
  document.head.append(sheet);
}

/**
 * jsdom has no `showModal()`/`show()`/`close()` on `<dialog>`. This stub stands in for them, as far
 * as Dialog's and Drawer's tests need:
 * - `showModal()` sets `open`, marks the dialog modal (`data-modal`) and focuses its first
 *   focusable element, like the browser's dialog focusing steps;
 * - `close()` removes `open` and fires `close` (synchronously here; the browser queues it);
 * - Escape fires a cancelable `cancel` on the topmost modal dialog and closes it unless the event
 *   is cancelled, like the browser's close request.
 * It doesn't model the top layer, inertness of the rest of the page, or focus restoring.
 */
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  const MODAL = "data-modal";
  const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex='-1'])";
  const openModals: HTMLDialogElement[] = [];

  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        if (this.open) return;
        this.setAttribute("open", "");
        this.setAttribute(MODAL, "");
        openModals.push(this);
        (this.querySelector<HTMLElement>("[autofocus]") ?? this.querySelector<HTMLElement>(FOCUSABLE))?.focus();
      },
    },
    show: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement, returnValue?: string) {
        if (!this.open) return;
        if (returnValue !== undefined) this.returnValue = returnValue;
        this.removeAttribute("open");
        this.removeAttribute(MODAL);
        if (openModals.includes(this)) openModals.splice(openModals.indexOf(this), 1);
        this.dispatchEvent(new Event("close"));
      },
    },
  });

  document.addEventListener("keydown", (event) => {
    // A dialog unmounted while open (cleanup between tests) never closes: skip it.
    const top = openModals.filter((dialog) => dialog.isConnected && dialog.open).at(-1);
    if (event.key !== "Escape" || top === undefined) return;
    if (top.dispatchEvent(new Event("cancel", { cancelable: true }))) top.close();
  });
}

afterEach(() => {
  cleanup();
});
