import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import enApp from "@/locales/en/app.json";
import enChat from "@/locales/en/chat.json";
import enCommon from "@/locales/en/common.json";
import enSettings from "@/locales/en/settings.json";
import enSidepane from "@/locales/en/sidepane.json";
import zhApp from "@/locales/zh/app.json";
import zhChat from "@/locales/zh/chat.json";
import zhCommon from "@/locales/zh/common.json";
import zhSettings from "@/locales/zh/settings.json";
import zhSidepane from "@/locales/zh/sidepane.json";
import { detectSystemLanguage, htmlLang, type UiLanguage } from "./language";

/**
 * Renderer i18n. `common` holds everything the shared `lib/*` modules render
 * (tool labels, permission modes, thinking levels, shortcut names, durations);
 * the other four namespaces follow the surface that owns them.
 *
 * The instance is the i18next singleton so `react-i18next`'s hooks resolve it
 * with no provider, while non-React modules can call `i18n.t` directly at the
 * moment they build a string (an event handler, a store action). Components that
 * render translated text must still call `useTranslation` so a language switch
 * re-renders them.
 */
export const I18N_NAMESPACES = ["common", "app", "chat", "settings", "sidepane"] as const;

export const i18n = i18next;

void i18n.use(initReactI18next).init({
  resources: {
    zh: { common: zhCommon, app: zhApp, chat: zhChat, settings: zhSettings, sidepane: zhSidepane },
    en: { common: enCommon, app: enApp, chat: enChat, settings: enSettings, sidepane: enSidepane },
  },
  // The pre-mount default; `applyUiLanguage` stamps the persisted choice from
  // `main.tsx` before the first render, exactly like the theme.
  lng: detectSystemLanguage(),
  fallbackLng: "zh",
  defaultNS: "common",
  ns: [...I18N_NAMESPACES],
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** Point i18n at a language and keep `<html lang>` (screen readers, hyphenation) in step. */
export function applyUiLanguage(language: UiLanguage): void {
  if (typeof document !== "undefined") document.documentElement.lang = htmlLang(language);
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

/** Translate outside React (store actions, event handlers, cached builders). */
export function translate(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options) as string;
}

/** The language i18next is currently rendering in, narrowed to the pair we ship. */
export function activeLanguage(): UiLanguage {
  return i18n.language === "en" ? "en" : "zh";
}

export default i18n;
