import { UI_LANGUAGE_ENV } from "./ai-language";

/**
 * Picks the wording for a user-facing string produced in Main.
 *
 * Main owns text the user ends up reading — IPC error toasts, native dialogs,
 * notifications, and the per-session labels of the 导入 pane. The language reaches
 * the process through `FASTVIBE_UI_LANGUAGE`, which is synced from `settings.json`
 * on every settings write (see `applyLanguages`), so the renderer and Main never
 * disagree about which language is active.
 *
 * Call this at the moment a string is produced, inside the function that emits it.
 * Caching the result in a module-level constant would freeze whichever language the
 * process happened to start in, so a later 界面语言 change would never reach it.
 */
export function uiText(zh: string, en: string): string {
  return process.env[UI_LANGUAGE_ENV] === "en" ? en : zh;
}
