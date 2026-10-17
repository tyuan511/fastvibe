export type BrowserHistoryEntry = { url: string; title: string; visitedAt: number };
export type BrowserDownload = {
  id: string;
  name: string;
  url: string;
  path: string;
  received: number;
  total: number;
  startedAt: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  paused: boolean;
  canResume: boolean;
};
export type BrowserLibrary = { history: BrowserHistoryEntry[]; downloads: BrowserDownload[] };
export type BrowserClearData = { cookies?: boolean; cache?: boolean; history?: boolean; downloads?: boolean };
export type BrowserDownloadAction = "pause" | "resume" | "cancel" | "reveal";
export type BrowserShortcut = "address" | "find" | "reload" | "reloadIgnoringCache" | "print" | "zoomIn" | "zoomOut" | "zoomReset" | "escape" | "back" | "forward";

/** Used for both Chromium input and the host toolbar's DOM keyboard events. */
export function browserShortcut(input: { key: string; control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }, mac: boolean): BrowserShortcut | null {
  const key = input.key.toLowerCase();
  if (key === "escape") return "escape";
  if (key === "f5") return input.shift ? "reloadIgnoringCache" : "reload";
  if (input.alt && !input.control && !input.meta) {
    if (key === "arrowleft") return "back";
    if (key === "arrowright") return "forward";
  }
  if (!(mac ? input.meta : input.control) || input.alt) return null;
  if (key === "r") return input.shift ? "reloadIgnoringCache" : "reload";
  if (key === "+" || key === "=") return "zoomIn";
  if (key === "-" || key === "_") return "zoomOut";
  if (input.shift) return null;
  const commands: Record<string, BrowserShortcut> = { l: "address", f: "find", p: "print", "0": "zoomReset", "[": "back", "]": "forward" };
  return commands[key] ?? null;
}

export function normalizeBrowserUrl(value: string): string {
  const text = value.trim();
  if (!text) return "about:blank";
  // A host and port is an address, not a URI scheme (localhost:5173).
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)) return `http://${text}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s/:]+\.\w+:\d+(?:[/?#]|$)/.test(text)) return text;
  if (/\s/u.test(text) || /[^\x00-\x7f]/u.test(text) || (!text.includes(".") && !text.startsWith("["))) return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  return `https://${text}`;
}

/** Recent pages, newest first. Never store internal documents or embedded data. */
export function visitBrowserPage(history: BrowserHistoryEntry[], entry: BrowserHistoryEntry): BrowserHistoryEntry[] {
  try {
    if (!["http:", "https:", "file:"].includes(new URL(entry.url).protocol)) return history;
  } catch { return history; }
  return [{ ...entry, title: entry.title.slice(0, 512) }, ...history.filter((item) => item.url !== entry.url)].slice(0, 500);
}

export const BROWSER_ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export function nextBrowserZoom(current: number, direction: 1 | -1): number {
  const steps = direction > 0 ? BROWSER_ZOOM_STEPS : [...BROWSER_ZOOM_STEPS].reverse();
  return steps.find((step) => direction > 0 ? step > current + 0.01 : step < current - 0.01) ?? current;
}
