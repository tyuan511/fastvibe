import { useEffect } from "react";
import { useSettingsStore } from "@/stores/settings";
import { applyThemePreferences } from "@/lib/themes";

/**
 * Keeps <html> in sync with the persisted appearance settings, including live
 * OS colour-scheme changes while `themeMode` is "system".
 */
export function useThemeSync(): void {
  const themeMode = useSettingsStore((state) => state.settings.themeMode);
  const lightTheme = useSettingsStore((state) => state.settings.lightTheme);
  const darkTheme = useSettingsStore((state) => state.settings.darkTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      applyThemePreferences({ themeMode, lightTheme, darkTheme });
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themeMode, lightTheme, darkTheme]);
}
