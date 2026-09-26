import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";

/**
 * Settings that belong to this phone, not to the machine it connects to: the theme
 * and whether taps buzz. (The language is `i18n/index.ts`.) Kept in AsyncStorage and
 * read once before the first screen draws.
 */
export type ThemePreference = "system" | "light" | "dark";
export type Preferences = { theme: ThemePreference; haptics: boolean };

const KEY = "fastvibe.preferences.v1";
const DEFAULTS: Preferences = { theme: "system", haptics: true };

let preferences: Preferences = DEFAULTS;
const listeners = new Set<() => void>();

export async function loadPreferences(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Preferences>) : {};
    apply({
      theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : "system",
      haptics: parsed.haptics !== false,
    });
  } catch {
    apply(DEFAULTS);
  }
}

export async function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void> {
  apply({ ...preferences, [key]: value });
  await AsyncStorage.setItem(KEY, JSON.stringify(preferences)).catch(() => undefined);
}

export function currentPreferences(): Preferences {
  return preferences;
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preferences,
    () => preferences,
  );
}

/**
 * The theme goes through `Appearance.setColorScheme`, not a context of our own: every
 * `useColorScheme()` then answers with the override, and so do the parts React does not
 * draw — alerts, the keyboard, the status bar's default.
 */
function apply(next: Preferences): void {
  preferences = next;
  Appearance.setColorScheme(next.theme === "system" ? "unspecified" : next.theme);
  for (const listener of listeners) listener();
}
