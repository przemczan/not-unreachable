import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** The `localStorage` key that remembers the theme the user chose. */
export const THEME_STORAGE_KEY = "nu-theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** The theme the user chose before, if storage holds one and can be read. */
function storedTheme(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The system's colour scheme; light where `matchMedia` is missing. */
function systemTheme(): Theme {
  if (typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The theme to start with: the stored choice, else the system's colour scheme. */
export function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return storedTheme() ?? systemTheme();
}

/** Shows the page in `theme`: the tokens follow `data-theme` on `<html>`. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

/**
 * Shows the remembered theme (else the system's) before the app's first render, so every layout
 * opens in it, not only AppShell, and AppShell doesn't flash the light theme first. Call it once,
 * before `createRoot(…).render(…)`: the CSP allows no inline script in `index.html` to do it.
 */
export function applyInitialTheme(): void {
  applyTheme(initialTheme());
}

export interface UseThemeResult {
  /** The theme shown now. */
  theme: Theme;
  /** Shows `theme` and remembers it. */
  setTheme: (theme: Theme) => void;
  /** Switches between light and dark and remembers the choice. */
  toggleTheme: () => void;
}

/**
 * The light/dark theme: starts from the user's stored choice (`localStorage` `nu-theme`), else the
 * system's `prefers-color-scheme`; keeps `data-theme` on `<html>` in step and stores every choice.
 */
export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage may be full or blocked: the theme still changes, it is just not remembered.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  return { theme, setTheme, toggleTheme };
}
