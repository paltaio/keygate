import { useState } from "react";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

const KEY = "keygate-theme";

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Applies the choice to <html> and remembers it. Transitions are suppressed for the swap. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return [
    theme,
    (next) => {
      applyTheme(next);
      setTheme(next);
    },
  ];
}
