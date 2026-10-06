"use client";

import { useTranslations } from "next-intl";
import { THEME_KEY } from "@/lib/theme";
import { Icon } from "./icons";

/**
 * Until the visitor chooses, the page follows the OS. A click flips whatever is on
 * screen right now and remembers it; the icon is picked by CSS from the same state,
 * so it is right before hydration and without JavaScript.
 */
export function ThemeSwitch() {
  const t = useTranslations("theme");
  const toggle = () => {
    const root = document.documentElement;
    const next = getComputedStyle(root).colorScheme.startsWith("dark") ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage may be blocked */ }
  };
  return (
    <button type="button" className="theme-switch" aria-label={t("toggle")} title={t("toggle")} onClick={toggle}>
      <Icon name="sun" size={16} className="icon-sun" />
      <Icon name="moon" size={16} className="icon-moon" />
    </button>
  );
}
