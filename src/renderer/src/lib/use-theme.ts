import { useEffect, useSyncExternalStore } from "react";
import { useSettingsStore } from "@/stores/settings";
import { applyThemePreferences, applyUiFontSize } from "@/lib/themes";

/**
 * Keeps <html> in sync with the persisted appearance settings, including live
 * OS colour-scheme changes while `themeMode` is "system". The 界面字号 setting
 * scales the whole interface through the root font size (text is rem-authored).
 */
export function useThemeSync(): void {
  const themeMode = useSettingsStore((state) => state.settings.themeMode);
  const lightTheme = useSettingsStore((state) => state.settings.lightTheme);
  const darkTheme = useSettingsStore((state) => state.settings.darkTheme);
  const glass = useSettingsStore((state) => state.settings.glass);
  const uiFontSize = useSettingsStore((state) => state.settings.uiFontSize);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      applyThemePreferences({ themeMode, lightTheme, darkTheme, glass });
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themeMode, lightTheme, darkTheme, glass]);

  useEffect(() => {
    applyUiFontSize(uiFontSize);
  }, [uiFontSize]);
}

/**
 * Whether the interface is on a dark theme, live.
 *
 * It reads what `applyTheme` already wrote to `<html>` rather than re-resolving the settings:
 * the theme is painted before mount, and re-deriving it here would put a second copy of the
 * `themeMode` / 跟随系统 rule in the codebase — the exact drift that this file exists to avoid.
 * One `MutationObserver` serves every subscriber, so a file tree with a hundred rows costs one
 * listener, not a hundred.
 */
const subscribers = new Set<() => void>();
let observer: MutationObserver | null = null;

function isDarkTheme(): boolean {
  const root = document.documentElement;
  return root.dataset.themeKind === "dark" || root.classList.contains("dark");
}

function subscribeThemeKind(notify: () => void): () => void {
  subscribers.add(notify);
  observer ??= new MutationObserver(() => {
    subscribers.forEach((listener) => listener());
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme-kind"] });
  return () => {
    subscribers.delete(notify);
    if (!subscribers.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}

export function useIsDarkTheme(): boolean {
  return useSyncExternalStore(subscribeThemeKind, isDarkTheme, () => false);
}
