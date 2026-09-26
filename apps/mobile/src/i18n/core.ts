import { en } from "./en.ts";
import { zh, type MessageKey } from "./zh.ts";

/**
 * The phone's strings, in two languages.
 *
 * Pure on purpose — no React Native import — so the modules `node --test` loads
 * (`chat/queue.ts`, `chat/turn-meta.ts`) can translate too. Persistence and the React
 * hook live in `i18n/index.ts`. `t` reads the language at call time, so a string built
 * in an event handler or an error follows a switch made after the module loaded.
 */

export type Language = "zh" | "en";
export type { MessageKey };

const DICTIONARIES: Record<Language, Partial<Record<string, string>> & Record<MessageKey, string>> = { zh, en };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let current: Language = systemLanguage();
const listeners = new Set<() => void>();

/** Chinese for any `zh*` locale, English for everything else. */
export function systemLanguage(): Language {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  for (const listener of listeners) listener();
}

export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `t("devices.deleteBody", { name })` — `{name}` in the message is replaced. With
 * `count: 1`, a `<key>_one` entry wins where the language has one (English does:
 * "1 chat", not "1 chats"; Chinese needs none).
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[current];
  const template = (vars?.count === 1 ? dictionary[`${key}_one`] : undefined) ?? dictionary[key] ?? zh[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** The locale tag `toLocale*String` should format with. */
export function locale(): string {
  return current === "zh" ? "zh-CN" : "en-US";
}

/** `9月3日` / `Sep 3`, with the year when it is not this one. */
export function formatMonthDay(date: Date, withYear: boolean): string {
  const vars = { year: date.getFullYear(), month: date.getMonth() + 1, monthName: MONTHS[date.getMonth()]!, day: date.getDate() };
  return withYear ? t("time.yearMonthDay", vars) : t("time.monthDay", vars);
}
