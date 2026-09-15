import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TuiRun } from "@shared/types";

/**
 * pi stores its active theme on a `globalThis` symbol so every module loader
 * (the SDK, jiti-loaded extensions) shares one instance. The root export is a
 * lazy proxy over it; reading the symbol lets us hand the real instance to a
 * component factory without going through the proxy.
 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const LEGACY_THEME_KEY = Symbol.for("@mariozechner/pi-coding-agent:theme");

type PiTheme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  getFgAnsi(name: string): string;
  getBgAnsi(name: string): string;
};

function currentTheme(): PiTheme {
  return ((globalThis as Record<symbol, unknown>)[THEME_KEY] ??
    (globalThis as Record<symbol, unknown>)[LEGACY_THEME_KEY]) as PiTheme;
}

/**
 * Renders pi-tui components (extension widgets) to structured lines for the GUI.
 *
 * Extensions build terminal components with `theme.fg(color, text)` and friends;
 * the result is an ANSI string. Rather than emulate a terminal, we parse the SGR
 * sequences back into runs, folding the known pi theme colors back into their
 * names so the renderer can map them onto the app's semantic tokens. Unknown
 * colors keep their literal RGB/256 value as a fallback.
 */

/**
 * Every foreground name the pi theme can resolve (`ThemeColor`).
 *
 * Order matters: multiple names often alias one color, and the index keeps the
 * first match, so the semantic names come before the markdown/syntax aliases
 * (`dim` before `mdLinkUrl`, `success` before `bashMode`, …).
 */
const FG_COLORS = [
  "text", "accent", "success", "error", "warning", "muted", "dim",
  "border", "borderAccent", "borderMuted", "mdHeading", "mdLink", "mdCode", "mdQuote",
  "customMessageText", "customMessageLabel", "toolTitle", "toolOutput", "thinkingText",
  "mdLinkUrl", "mdCodeBlock", "mdCodeBlockBorder", "mdQuoteBorder", "mdHr", "mdListBullet",
  "scrollbarTrack", "scrollbarThumb", "searchMatchText", "userMessageText",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction",
  "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
  "thinkingMax", "bashMode",
] as const;

/** Every background name the pi theme can resolve (`ThemeBg`). */
const BG_COLORS = [
  "selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg",
  "toolErrorBg",
] as const;

type ColorIndex = Map<string, { fg?: string; bg?: string }>;

let initialized = false;
let colorIndex: ColorIndex | null = null;

function ensureTheme(): void {
  if (initialized) return;
  initialized = true;
  try {
    initTheme(undefined, false);
  } catch {
    // No terminal in the main process; the widget render below simply yields
    // whatever the theme produced (or nothing) rather than throwing.
  }
}

function getColorIndex(): ColorIndex {
  if (colorIndex) return colorIndex;
  const index: ColorIndex = new Map();
  const t = currentTheme();
  for (const name of FG_COLORS) {
    try {
      const ansi = t.getFgAnsi(name);
      const existing = index.get(ansi);
      // First name wins: aliases share a value and the earliest is the semantic one.
      if (!existing?.fg) index.set(ansi, { ...(existing ?? {}), fg: name });
    } catch {
      // Name not present in this theme.
    }
  }
  for (const name of BG_COLORS) {
    try {
      const ansi = t.getBgAnsi(name);
      const existing = index.get(ansi);
      if (!existing?.bg) index.set(ansi, { ...(existing ?? {}), bg: name });
    } catch {
      // Name not present in this theme.
    }
  }
  colorIndex = index;
  return index;
}

export type TuiComponent = { render(width: number): string[]; dispose?(): void };

/**
 * Instantiate a widget factory against a stub TUI. The widget only reads
 * `requestRender`, `children` (for dock sizing) and `terminal.rows` (for height
 * bounding), all of which degrade gracefully, so a minimal object suffices.
 * Returns null when the factory throws (a broken plugin must not break the app).
 */
export function createTuiWidget(factory: unknown): TuiComponent | null {
  ensureTheme();
  const tui = { requestRender: () => undefined } as unknown;
  try {
    return (factory as (tui: unknown, th: unknown) => TuiComponent)(tui, currentTheme());
  } catch {
    return null;
  }
}

/** Render an existing component instance to structured lines. */
export function renderTuiComponent(component: TuiComponent, width: number): TuiRun[][] {
  let lines: string[];
  try {
    lines = component.render(Math.max(1, width)) ?? [];
  } catch {
    return [];
  }
  const index = getColorIndex();
  return lines.map((line) => parseLine(line, index));
}

/** Convenience: create and render a factory in one shot. */
export function renderTuiWidget(factory: unknown, width: number): TuiRun[][] {
  const component = createTuiWidget(factory);
  return component ? renderTuiComponent(component, width) : [];
}

/**
 * Render an extension's `registerMessageRenderer` output. The renderer receives
 * the raw custom message, its options and the live pi theme, and returns a
 * pi-tui component — exactly what the terminal transcript would draw. Returning
 * undefined (no renderer) leaves the caller to fall back to the message text.
 */
// The renderer is the SDK's `MessageRenderer`, whose typed parameters we cannot
// name here without importing its generics; callers pass it straight through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderExtensionMessage(
  renderer: (...args: any[]) => TuiComponent | undefined,
  message: unknown,
  width: number,
): TuiRun[][] | undefined {
  ensureTheme();
  try {
    const component = renderer(message, { expanded: true, outputPad: 0 }, currentTheme());
    return component ? renderTuiComponent(component, width) : undefined;
  } catch {
    return undefined;
  }
}

const ESCAPE_RE = /^\x1b\[([0-9;]*)([A-Za-z])/;

function parseLine(line: string, index: ColorIndex): TuiRun[] {
  const runs: TuiRun[] = [];
  let state: TuiRun = { text: "" };
  const flush = (): void => {
    if (state.text) runs.push({ ...state, text: state.text });
    state = { ...state, text: "" };
  };
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const match = ESCAPE_RE.exec(line.slice(i));
      if (match) {
        i += match[0].length;
        if (match[2] === "m") {
          flush();
          applySgr(match[1] ?? "", state, index);
        }
        continue;
      }
      i += 1;
      continue;
    }
    state.text += line[i];
    i += 1;
  }
  flush();
  return runs.length > 0 ? runs : [{ text: "" }];
}

function applySgr(paramStr: string, state: TuiRun, index: ColorIndex): void {
  const parts = paramStr === "" ? [0] : paramStr.split(";").map((value) => Number(value) || 0);
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i] ?? 0;
    if (code === 0) {
      delete state.fg; delete state.bg; delete state.color; delete state.bgColor;
      delete state.bold; delete state.dim; delete state.italic; delete state.underline; delete state.strike;
    } else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 9) state.strike = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 29) state.strike = false;
    else if (code === 39) { delete state.fg; delete state.color; }
    else if (code === 49) { delete state.bg; delete state.bgColor; }
    else if (code === 38 || code === 48) {
      const isFg = code === 38;
      const mode = parts[i + 1];
      if (mode === 5) {
        const ansi = `\x1b[${code};5;${parts[i + 2] ?? 0}m`;
        applyColor(state, isFg, index.get(ansi), xterm256Css(parts[i + 2] ?? 0));
        i += 2;
      } else if (mode === 2) {
        const r = parts[i + 2] ?? 0;
        const g = parts[i + 3] ?? 0;
        const b = parts[i + 4] ?? 0;
        const ansi = `\x1b[${code};2;${r};${g};${b}m`;
        applyColor(state, isFg, index.get(ansi), rgbCss(r, g, b));
        i += 4;
      }
    } else if (code >= 30 && code <= 37) applyNamed(state, true, code - 30);
    else if (code >= 90 && code <= 97) applyNamed(state, true, code - 90 + 8);
    else if (code >= 40 && code <= 47) applyNamed(state, false, code - 40);
    else if (code >= 100 && code <= 107) applyNamed(state, false, code - 100 + 8);
  }
}

function applyColor(state: TuiRun, isFg: boolean, named: { fg?: string; bg?: string } | undefined, css: string): void {
  if (isFg) {
    if (named?.fg) { state.fg = named.fg; delete state.color; }
    else { state.color = css; delete state.fg; }
  } else if (named?.bg) { state.bg = named.bg; delete state.bgColor; }
  else { state.bgColor = css; delete state.bg; }
}

function applyNamed(state: TuiRun, isFg: boolean, index256: number): void {
  const css = xterm256Css(index256);
  if (isFg) { state.color = css; delete state.fg; }
  else { state.bgColor = css; delete state.bg; }
}

function rgbCss(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/** Standard xterm 256-color palette → `#rrggbb`. */
function xterm256Css(index: number): string {
  const n = Math.max(0, Math.min(255, Math.floor(index)));
  if (n < 16) return BASIC_16[n] ?? "#888888";
  if (n < 232) {
    const c = n - 16;
    const scale = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return rgbCss(scale(Math.floor(c / 36)), scale(Math.floor((c % 36) / 6)), scale(c % 6));
  }
  const gray = 8 + (n - 232) * 10;
  return rgbCss(gray, gray, gray);
}

const BASIC_16 = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];
