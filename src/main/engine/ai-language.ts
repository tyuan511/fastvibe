/**
 * Language plumbing between `settings.json`, the embedded engine, and the
 * standalone built-in extensions.
 *
 * The extensions are jiti modules loaded outside the Electron bundle (see
 * `resources/extensions/permission-sandbox.ts`), so they cannot import this file.
 * The process environment is the one channel they share with Main, exactly like
 * `FASTVIBE_PERMISSION_MODE`, and it is enough because the extensions re-read it
 * per event — a settings change reaches a running session.
 *
 * Two different things travel through it:
 *
 * - `FASTVIBE_UI_LANGUAGE` is the *value* (`zh` | `en`) of 界面语言. Extensions that
 *   render their own UI text (permission prompts, status widgets) map it to their
 *   own copy.
 * - `FASTVIBE_AI_LANGUAGE` is the value of AI 偏好语言, for the few extension strings
 *   the *model* reads (a blocked tool's reason, a continuation nudge).
 * - `FASTVIBE_AI_LANGUAGE_PROMPT` is the finished *sentence* for AI 偏好语言. Main
 *   owns the wording so the prompt cannot drift between the extension that injects
 *   it every turn and the subagent runner that puts it on a delegated role's system
 *   prompt; the extension just appends whatever it finds.
 */

export const UI_LANGUAGE_ENV = "FASTVIBE_UI_LANGUAGE";
export const AI_LANGUAGE_ENV = "FASTVIBE_AI_LANGUAGE";
export const AI_LANGUAGE_PROMPT_ENV = "FASTVIBE_AI_LANGUAGE_PROMPT";

export type UiLanguage = "zh" | "en";

const DIRECTIVES: Record<UiLanguage, string> = {
  zh: "Language requirement: always write your replies in Simplified Chinese (简体中文), regardless of the language the user writes in, the language of the code, or the messages before this one.",
  en: "Language requirement: always write your replies in English, regardless of the language the user writes in, the language of the code, or the messages before this one.",
};

/**
 * A persisted language value, or `zh` — the language the app shipped in before the
 * setting existed, which is also what an older `settings.json` should keep.
 */
export function uiLanguageOf(value: unknown): UiLanguage {
  return value === "en" ? "en" : "zh";
}

/** The per-turn system-prompt suffix for the current AI 偏好语言. */
export function aiLanguageDirective(settings: Record<string, unknown>): string {
  return DIRECTIVES[uiLanguageOf(settings.aiLanguage)];
}

/**
 * What the extensions and the subagent runner read back, straight from the env: the
 * same string `applyLanguages` last wrote. `undefined` only before the first apply,
 * which the startup call rules out.
 */
export function currentAiLanguageDirective(): string | undefined {
  const value = process.env[AI_LANGUAGE_PROMPT_ENV]?.trim();
  return value ? value : undefined;
}

/** Hand both languages to the embedded engine. Called on every settings write so a
 * change lands in sessions that are already running. */
export function applyLanguages(settings: Record<string, unknown>): void {
  const ui = uiLanguageOf(settings.uiLanguage);
  const ai = uiLanguageOf(settings.aiLanguage);
  process.env[UI_LANGUAGE_ENV] = ui;
  process.env[AI_LANGUAGE_ENV] = ai;
  process.env[AI_LANGUAGE_PROMPT_ENV] = DIRECTIVES[ai];
}
