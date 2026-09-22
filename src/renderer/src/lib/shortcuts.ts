import { i18n } from "@/lib/i18n";
import { IS_MAC } from "@/lib/platform";

/** Display order of the shortcut groups; labels come from `shortcutGroupLabel`. */
export const SHORTCUT_GROUPS = ["general", "chat", "view"] as const;

export type ShortcutGroupId = (typeof SHORTCUT_GROUPS)[number];

export type ShortcutId =
  | "commandPalette"
  | "settings"
  | "newChat"
  | "openFolder"
  | "focusComposer"
  | "send"
  | "stop"
  | "prevChat"
  | "nextChat"
  | "toggleSidebar"
  | "toggleSidePane";

export type ShortcutDef = {
  id: ShortcutId;
  group: ShortcutGroupId;
  default: string;
};

/** Catalog is the single source of truth for defaults and settings rows. Names are
 * translated through `shortcutLabel` / `shortcutDescription` so the catalog itself
 * stays language-free. */
export const SHORTCUT_CATALOG: ShortcutDef[] = [
  { id: "commandPalette", group: "general", default: "mod+k" },
  { id: "settings", group: "general", default: "mod+," },
  { id: "newChat", group: "chat", default: "mod+n" },
  { id: "openFolder", group: "chat", default: "mod+o" },
  { id: "focusComposer", group: "chat", default: "mod+l" },
  { id: "send", group: "chat", default: "mod+enter" },
  { id: "stop", group: "chat", default: "escape" },
  { id: "prevChat", group: "chat", default: "mod+[" },
  { id: "nextChat", group: "chat", default: "mod+]" },
  { id: "toggleSidebar", group: "view", default: "mod+b" },
  { id: "toggleSidePane", group: "view", default: "mod+j" },
];

export function shortcutGroupLabel(group: ShortcutGroupId): string {
  return i18n.t(`common:shortcuts.group.${group}`) as string;
}

export function shortcutLabel(id: ShortcutId): string {
  return i18n.t(`common:shortcuts.${id}`) as string;
}

/** Optional second line; only some commands carry one. */
export function shortcutDescription(id: ShortcutId): string | undefined {
  const key = `common:shortcuts.${id}Desc`;
  return i18n.exists(key) ? (i18n.t(key) as string) : undefined;
}

const SHORTCUT_IDS = new Set<string>(SHORTCUT_CATALOG.map((item) => item.id));
const DEFAULT_BY_ID = new Map(SHORTCUT_CATALOG.map((item) => [item.id, item.default]));

export type ShortcutOverrides = Partial<Record<ShortcutId, string | null>>;
export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

export type KeyChord = {
  key: string;
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

const BARE_KEYS = new Set(["escape", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"]);

const RESERVED = new Set([
  "mod+c",
  "mod+v",
  "mod+x",
  "mod+a",
  "mod+z",
  "mod+shift+z",
  "mod+q",
  "mod+w",
  "mod+m",
  "mod+h",
  "mod+tab",
  "alt+tab",
]);

const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  comma: ",",
  period: ".",
  plus: "+",
  minus: "-",
  spacebar: "space",
  arrowup: "arrowup",
  arrowdown: "arrowdown",
  arrowleft: "arrowleft",
  arrowright: "arrowright",
  "[": "[",
  "]": "]",
};

const MODIFIER_KEYS = new Set(["meta", "control", "ctrl", "alt", "shift", "hyper", "os", "super", "dead", "unidentified", "process"]);

let recordingDepth = 0;

export function beginShortcutRecording(): void {
  recordingDepth += 1;
}

export function endShortcutRecording(): void {
  recordingDepth = Math.max(0, recordingDepth - 1);
}

export function isShortcutRecording(): boolean {
  return recordingDepth > 0;
}

export function isShortcutId(value: string): value is ShortcutId {
  return SHORTCUT_IDS.has(value);
}

export function parseChord(raw: string): KeyChord | null {
  const parts = raw
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const chord: KeyChord = { key: "" };
  for (const part of parts) {
    if (part === "mod" || part === "cmd" || part === "meta" || part === "command" || part === "super") chord.mod = true;
    else if (part === "ctrl" || part === "control") chord.ctrl = true;
    else if (part === "alt" || part === "option") chord.alt = true;
    else if (part === "shift") chord.shift = true;
    else chord.key = normalizeKey(part);
  }
  return chord.key ? chord : null;
}

export function serializeChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  if (chord.mod) parts.push("mod");
  parts.push(chord.key);
  return parts.join("+");
}

export function chordFromEvent(event: KeyboardEvent): KeyChord | null {
  if (event.isComposing) return null;
  const key = normalizeKey(event.key);
  if (!key || MODIFIER_KEYS.has(key)) return null;
  const chord: KeyChord = { key };
  if (IS_MAC) {
    if (event.metaKey) chord.mod = true;
    if (event.ctrlKey) chord.ctrl = true;
  } else if (event.ctrlKey || event.metaKey) {
    chord.mod = true;
  }
  if (event.altKey) chord.alt = true;
  if (event.shiftKey) chord.shift = true;
  return chord;
}

export function matchChord(event: KeyboardEvent, raw: string): boolean {
  const expected = parseChord(raw);
  const actual = chordFromEvent(event);
  if (!expected || !actual || actual.key !== expected.key) return false;
  if (Boolean(actual.alt) !== Boolean(expected.alt)) return false;
  if (Boolean(actual.shift) !== Boolean(expected.shift)) return false;
  if (IS_MAC) {
    return Boolean(actual.mod) === Boolean(expected.mod) && Boolean(actual.ctrl) === Boolean(expected.ctrl);
  }
  return Boolean(actual.mod || actual.ctrl) === Boolean(expected.mod || expected.ctrl);
}

export function formatChord(raw: string, mac = IS_MAC): string {
  const chord = parseChord(raw);
  if (!chord) return raw;
  const key = formatKey(chord.key, mac);
  if (mac) {
    return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${key}`;
  }
  const parts: string[] = [];
  if (chord.mod || chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function chordUsable(chord: KeyChord): string | null {
  const hasModifier = Boolean(chord.mod || chord.ctrl || chord.alt);
  if (!hasModifier && !BARE_KEYS.has(chord.key)) return i18n.t("common:shortcuts.needModifier") as string;
  const serialized = serializeChord(chord);
  if (RESERVED.has(serialized)) return i18n.t("common:shortcuts.reserved") as string;
  return null;
}

export function resolveBinding(id: ShortcutId, overrides?: ShortcutOverrides | null): string | null {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id] ?? null;
  }
  return DEFAULT_BY_ID.get(id) ?? null;
}

export function resolveBindings(overrides?: ShortcutOverrides | null): Record<ShortcutId, string | null> {
  const next = {} as Record<ShortcutId, string | null>;
  for (const item of SHORTCUT_CATALOG) next[item.id] = resolveBinding(item.id, overrides);
  return next;
}

export function defaultBinding(id: ShortcutId): string {
  return DEFAULT_BY_ID.get(id) ?? "";
}

export function sanitizeShortcutOverrides(value: unknown): ShortcutOverrides | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const next: ShortcutOverrides = {};
  let any = false;
  for (const [key, binding] of Object.entries(value)) {
    if (!isShortcutId(key)) continue;
    if (binding === null) {
      next[key] = null;
      any = true;
      continue;
    }
    if (typeof binding !== "string") continue;
    const chord = parseChord(binding);
    if (!chord) continue;
    next[key] = serializeChord(chord);
    any = true;
  }
  return any ? next : undefined;
}

export function shouldYieldToTerminal(event: KeyboardEvent): boolean {
  const node = event.target;
  const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!el?.closest(".xterm")) return false;
  if (IS_MAC) return event.ctrlKey && !event.metaKey;
  return event.ctrlKey;
}

function normalizeKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key === " ") return "space";
  return KEY_ALIASES[key] ?? key;
}

function formatKey(key: string, mac: boolean): string {
  if (key === "enter") return mac ? "↩" : "Enter";
  if (key === "escape") return "Esc";
  if (key === "space") return "Space";
  if (key === "tab") return "Tab";
  if (key === "backspace") return mac ? "⌫" : "Backspace";
  if (key === "delete") return mac ? "⌦" : "Del";
  if (key === "arrowup") return "↑";
  if (key === "arrowdown") return "↓";
  if (key === "arrowleft") return "←";
  if (key === "arrowright") return "→";
  if (key === "pageup") return "PgUp";
  if (key === "pagedown") return "PgDn";
  if (key.length === 1) return key.toUpperCase();
  return key.length <= 3 ? key.toUpperCase() : key;
}
