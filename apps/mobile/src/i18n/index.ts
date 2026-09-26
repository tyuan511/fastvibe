import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { getLanguage, onLanguageChange, setLanguage, systemLanguage, t, type Language } from "./core";

export { t, getLanguage, locale, formatMonthDay, type Language, type MessageKey } from "./core";

/** What the user picked in 设置 → 语言; `system` follows the phone. */
export type LanguagePreference = "system" | Language;

const KEY = "fastvibe.language.v1";
/** The device list's storage key — its presence marks an install from before i18n. */
const SERVERS_KEY = "fastvibe.servers.v1";

let preference: LanguagePreference = "system";
const preferenceListeners = new Set<() => void>();

/**
 * Read the stored choice before the first screen draws.
 *
 * An install that predates the setting keeps 中文 — the only language it ever had —
 * rather than switching to English because the phone's system language is English;
 * a new install follows the system. Same rule as the desktop's 界面语言.
 */
export async function loadLanguagePreference(): Promise<void> {
  try {
    let stored = (await AsyncStorage.getItem(KEY)) as LanguagePreference | null;
    if (stored !== "system" && stored !== "zh" && stored !== "en") {
      stored = (await AsyncStorage.getItem(SERVERS_KEY)) ? "zh" : "system";
      await AsyncStorage.setItem(KEY, stored);
    }
    applyPreference(stored);
  } catch {
    applyPreference("system");
  }
}

export async function setLanguagePreference(next: LanguagePreference): Promise<void> {
  applyPreference(next);
  await AsyncStorage.setItem(KEY, next).catch(() => undefined);
}

function applyPreference(next: LanguagePreference): void {
  preference = next;
  setLanguage(next === "system" ? systemLanguage() : next);
  for (const listener of preferenceListeners) listener();
}

export function useLanguagePreference(): LanguagePreference {
  return useSyncExternalStore(
    (listener) => {
      preferenceListeners.add(listener);
      return () => preferenceListeners.delete(listener);
    },
    () => preference,
    () => preference,
  );
}

/**
 * Subscribe a component to the language. Every component that renders copy calls
 * this, so a switch in 设置 redraws the screens already open behind it.
 */
export function useT(): { t: typeof t; language: Language } {
  const language = useSyncExternalStore(onLanguageChange, getLanguage, getLanguage);
  return { t, language };
}
