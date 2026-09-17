import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { applyUiLanguage } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings";

/**
 * Keeps the rendered language in sync with 设置 → 通用 → 语言.
 *
 * `applyUiLanguage` is the only writer of i18next's active language; the store
 * value is the source of truth, and `useTranslation` here subscribes the shell so
 * the whole tree re-renders when the language changes (components that render
 * translated text call `useTranslation` themselves, which is what updates the
 * memoised transcript rows).
 */
export function useLanguageSync(): void {
  const uiLanguage = useSettingsStore((state) => state.settings.uiLanguage);
  useTranslation();

  useEffect(() => {
    applyUiLanguage(uiLanguage);
  }, [uiLanguage]);
}
