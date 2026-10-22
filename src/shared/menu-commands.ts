/**
 * The commands the native menu bar carries.
 *
 * The menu is drawn by Main (it is native chrome, and it must exist before a window has
 * loaded), while the *keys* belong to the renderer: 设置 → 快捷键 is where bindings are
 * edited, and the app's whole command vocabulary lives there. So the split is:
 *
 *   - this file names the commands and says how one is spelled to Electron;
 *   - Main owns the labels and the menu's shape (like every other native surface it owns);
 *   - the window hands Main its effective bindings, and Main answers with the commands
 *     whose keys it registered.
 *
 * That last answer is what keeps the two halves honest. A menu accelerator is consumed by
 * the OS before the page ever sees the key, so a command the menu took must not also be
 * handled by the renderer's dispatcher — pressing 一次 would flip a toggle twice. On a
 * platform (or a preview harness) with no native menu, Main answers with nothing and the
 * page keeps handling every chord exactly as it did before.
 */

/** Commands the menu can draw. The last nine are ids in the renderer's shortcut catalog. */
export const MENU_COMMAND_IDS = [
  "about",
  "shortcutSettings",
  "settings",
  "newChat",
  "openFolder",
  "commandPalette",
  "focusComposer",
  "toggleSidebar",
  "toggleSidePane",
  "prevChat",
  "nextChat",
] as const;

export type MenuCommandId = (typeof MENU_COMMAND_IDS)[number];

/**
 * Serialized chords, in the format `serializeChord` writes (`mod+k`, `mod+shift+p`).
 * A missing key means "not bound", which is different from "not present": an unbound
 * command still appears in the menu, just with no key beside it.
 */
export type MenuBindings = Partial<Record<MenuCommandId, string | null>>;

const MODIFIERS = new Map<string, string>([
  ["mod", "Cmd"],
  ["cmd", "Cmd"],
  ["meta", "Cmd"],
  ["command", "Cmd"],
  ["super", "Cmd"],
  ["ctrl", "Ctrl"],
  ["control", "Ctrl"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
]);

/** Keys whose own name is what Electron spells them, folded to that spelling. */
const NAMED_KEYS = new Map<string, string>([
  ["enter", "Enter"],
  ["escape", "Esc"],
  ["tab", "Tab"],
  ["space", "Space"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["arrowup", "Up"],
  ["arrowdown", "Down"],
  ["arrowleft", "Left"],
  ["arrowright", "Right"],
]);

/**
 * Punctuation a chord may carry. These are the characters Electron's own accelerator
 * examples use; anything beyond them (`*`, `"` …) is a key Electron would accept as a
 * string and never match a keystroke to, so a menu would show a shortcut that does
 * nothing — worse than showing none.
 */
const PUNCTUATION = new Set([",", ".", "/", ";", "'", "`", "[", "]", "-", "=", "\\"]);

/**
 * Turning one of the app's chords into an Electron accelerator.
 *
 * `null` means the menu must not take this key at all: an unusable spelling, no modifier
 * (a bare `Escape` or `Enter` in a menu swallows every dialog and every text field in the
 * app), or a command this file does not know.
 */
export function chordToAccelerator(chord: string | null | undefined): string | null {
  if (typeof chord !== "string") return null;
  const parts = chord.trim().toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const translated: string[] = [];
  for (const mod of mods) {
    const name = MODIFIERS.get(mod);
    if (!name) return null;
    if (!translated.includes(name)) translated.push(name);
  }
  if (translated.length === 0) return null;
  const spelled = spelledKey(key);
  if (!spelled) return null;
  return `${[...translated, spelled].join("+")}`;
}

function spelledKey(key: string): string | null {
  const named = NAMED_KEYS.get(key);
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  if (/^[a-z]$/.test(key) || /^[0-9]$/.test(key)) return key.toUpperCase();
  return PUNCTUATION.has(key) ? key : null;
}

/** Keep only the commands the menu knows about, and only chords in serialized form. */
export function sanitizeMenuBindings(value: unknown): MenuBindings {
  const next: MenuBindings = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return next;
  for (const [key, chord] of Object.entries(value)) {
    if (!isMenuCommandId(key)) continue;
    if (chord === null || chord === undefined) {
      next[key] = null;
      continue;
    }
    if (typeof chord !== "string") continue;
    next[key] = chordToAccelerator(chord) ? chord : null;
  }
  return next;
}

export function isMenuCommandId(value: string): value is MenuCommandId {
  return (MENU_COMMAND_IDS as readonly string[]).includes(value);
}
