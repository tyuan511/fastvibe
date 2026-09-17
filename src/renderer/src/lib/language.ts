/**
 * Language primitives shared by the i18n setup, the settings store and the
 * 语言 pane. Kept free of any i18n/store import so both directions can use it
 * without a cycle (`settings.ts` ← this → `i18n.ts`).
 */

/** The languages FastVibe ships. One value drives both 界面语言 and AI 偏好语言. */
export type UiLanguage = "zh" | "en";

export const UI_LANGUAGES: readonly UiLanguage[] = ["zh", "en"];

/** Picker labels. Deliberately *not* translated: a language is always named in
 * itself, so an English-only reader can find their way out of a Chinese UI. */
export const UI_LANGUAGE_LABELS: Record<UiLanguage, string> = {
  zh: "简体中文",
  en: "English",
};

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "zh" || value === "en";
}

/**
 * First-run default, from the OS locale. FastVibe used to be Chinese-only, so an
 * install that already has settings predates the setting and keeps 中文 (see
 * `stores/settings.ts`); only a brand-new install follows the system.
 */
export function detectSystemLanguage(): UiLanguage {
  if (typeof navigator === "undefined") return "zh";
  const locales = navigator.languages?.length ? navigator.languages : [navigator.language];
  const first = locales.find((value) => typeof value === "string" && value.length > 0) ?? "";
  return /^zh\b/i.test(first) ? "zh" : "en";
}

/** `<html lang>` value for a language — the region-tagged form screen readers expect. */
export function htmlLang(language: UiLanguage): string {
  return language === "zh" ? "zh-CN" : "en";
}

/** BCP-47 tag for `Intl`/`toLocaleDateString`. */
export function localeTag(language: UiLanguage): string {
  return language === "zh" ? "zh-CN" : "en-US";
}
