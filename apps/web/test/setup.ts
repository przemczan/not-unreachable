import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// A file's first render (lazy routes, the design system's CSS) can pass the default 1 s of
// findBy*/waitFor when the whole workspace suite runs in parallel; stay under Vitest's 5 s test timeout.
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom has no matchMedia; components that ask for the colour scheme or motion preference need one.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
}

/**
 * jsdom has no Popover API, which the design system's Menu uses: a stand-in that keeps the open
 * state in an attribute and fires the toggle events, as the design system's own test setup does.
 */
if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover !== "function") {
  const OPEN = "data-popover-open";
  const setOpen = (element: HTMLElement, open: boolean): void => {
    if (!element.hasAttribute("popover") || element.hasAttribute(OPEN) === open) return;
    const [oldState, newState] = open ? ["closed", "open"] : ["open", "closed"];
    const before = Object.assign(new Event("beforetoggle", { cancelable: open }), { oldState, newState });
    if (!element.dispatchEvent(before)) return;
    element.toggleAttribute(OPEN, open);
    element.dispatchEvent(Object.assign(new Event("toggle"), { oldState, newState }));
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

/** jsdom has no `showModal()`/`close()` on `<dialog>`, which Dialog and Drawer use: a minimal stand-in. */
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex='-1'])";
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        if (this.open) return;
        this.setAttribute("open", "");
        (this.querySelector<HTMLElement>("[autofocus]") ?? this.querySelector<HTMLElement>(FOCUSABLE))?.focus();
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        if (!this.open) return;
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
      },
    },
  });
}
