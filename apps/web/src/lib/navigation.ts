import { useEffect } from "react";

/**
 * Leaves the app for another site, such as a sign-in provider's page, or loads a page of its own
 * afresh. An object, so the tests can replace its methods: jsdom's `window.location` can't be stubbed.
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  /** Loads `url` in place of the current page, which Back then skips. */
  replace(url: string): void {
    window.location.replace(url);
  },
  /** Loads the current page afresh. */
  reload(): void {
    window.location.reload();
  },
};

/**
 * Calls `onRestored` when the browser shows this page again from its back/forward cache, such as
 * Back from a provider that refused the sign-in: the page comes back as it was left, so anything
 * still showing "on the way to the provider" has to be reset. Pass a stable function, such as a
 * mutation's `reset`.
 */
export function usePageRestored(onRestored: () => void): void {
  useEffect(() => {
    const restored = (event: PageTransitionEvent): void => {
      if (event.persisted) onRestored();
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [onRestored]);
}
