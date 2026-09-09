import { useState } from "react";

const KEY = "keygate-sidebar";

export function readCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Mirrors the choice onto <html> for the stylesheet and remembers it. */
export function applyCollapsed(collapsed: boolean): void {
  const root = document.documentElement;
  if (collapsed) root.setAttribute("data-sidebar", "collapsed");
  else root.removeAttribute("data-sidebar");
  try {
    localStorage.setItem(KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

export function useSidebar(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  return [
    collapsed,
    () => {
      applyCollapsed(!collapsed);
      setCollapsed(!collapsed);
    },
  ];
}
