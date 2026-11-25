import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, applyInitialTheme, initialTheme, useTheme } from "./useTheme.ts";

function stubColourScheme(dark: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: dark && query.includes("dark"),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initialTheme", () => {
  it("is light without a stored choice or matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);

    expect(initialTheme()).toBe("light");
  });

  it("follows the system's colour scheme without a stored choice", () => {
    stubColourScheme(true);

    expect(initialTheme()).toBe("dark");
  });

  it("prefers the stored choice to the system's", () => {
    stubColourScheme(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");

    expect(initialTheme()).toBe("light");
  });

  it("ignores a stored value that is not a theme", () => {
    stubColourScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");

    expect(initialTheme()).toBe("light");
  });
});

describe("applyInitialTheme", () => {
  it("shows the stored choice on <html> before any layout renders", () => {
    stubColourScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    applyInitialTheme();

    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });

  it("shows the system's colour scheme without a stored choice", () => {
    stubColourScheme(true);

    applyInitialTheme();

    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });
});

describe("useTheme", () => {
  it("sets data-theme on <html> from the start", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });

  it("toggles the theme and remembers the choice", () => {
    stubColourScheme(false);
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => {
      result.current.setTheme("light");
    });

    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });
});
