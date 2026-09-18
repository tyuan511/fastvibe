/**
 * Single source of truth for the workspace sidebar width. The settings pane
 * renders its own sidebar, so it reads the same persisted value to stay the
 * same width as the conversation sidebar.
 *
 * The value is persisted in `userData/settings.json` through the settings store,
 * with localStorage kept only as a first-paint cache: localStorage does not
 * survive the electron origin switch between dev (`localhost`) and packaged
 * (`file://`), so it cannot be the source of truth.
 */

import { isNarrowViewport } from "@/lib/sidebar-visibility";
import { useSettingsStore } from "@/stores/settings";

const WIDTH_KEY = "fastvibe.sidebar.width";
const MIN_WIDTH = 200;
const DEFAULT_WIDTH = 288;
const MAX_WIDTH = 480;

/**
 * Never let the sidebar eat more than this share of the window.
 *
 * The share is about the sidebar being a *column* next to a conversation. On a narrow
 * viewport it is not one — it is a full-screen drawer — and applying the ceiling there
 * did real damage in both directions: 40% of a 375pt screen is 150, so the remembered
 * width read back as 150 (a sliver of a drawer, and 134px-wide rows in the drag
 * overlay), and any write from the phone would have stored that 150 in the preference
 * the desktop reads for its column. The stored number is a memory of the desktop's
 * layout; a phone has no business shrinking it.
 */
export function clampSidebarWidth(next: number): number {
  const bounded = Math.max(MIN_WIDTH, next);
  if (typeof window === "undefined" || isNarrowViewport()) return Math.round(Math.min(MAX_WIDTH, bounded));
  const max = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.4));
  return Math.round(Math.min(max, bounded));
}

/** Current sidebar width in px, clamped to the usable range. */
export function readSidebarWidth(): number {
  const stored = useSettingsStore.getState().settings.sidebarWidth;
  if (typeof stored === "number" && Number.isFinite(stored)) return clampSidebarWidth(stored);
  // Older installs persisted the width only in localStorage; migrate it on read.
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const value = raw ? Number(raw) : NaN;
    if (Number.isFinite(value)) return clampSidebarWidth(value);
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

/** Persist a width through the settings store (disk + first-paint cache). */
export function writeSidebarWidth(width: number): void {
  const clamped = clampSidebarWidth(width);
  try {
    localStorage.setItem(WIDTH_KEY, String(clamped));
  } catch {
    // ignore quota errors
  }
  useSettingsStore.getState().update({ sidebarWidth: clamped });
}

// One-time migration: earlier builds kept the width only in localStorage, which
// is not durable across the dev/packaged origin switch. Promote it to disk.
if (typeof window !== "undefined") {
  const store = useSettingsStore.getState();
  if (typeof store.settings.sidebarWidth !== "number") {
    try {
      const raw = localStorage.getItem(WIDTH_KEY);
      const value = raw ? Number(raw) : NaN;
      if (Number.isFinite(value)) store.update({ sidebarWidth: clampSidebarWidth(value) });
    } catch {
      // ignore
    }
  }
}

export const SIDEBAR_WIDTH_KEY = WIDTH_KEY;
export const SIDEBAR_MIN_WIDTH = MIN_WIDTH;
export const SIDEBAR_DEFAULT_WIDTH = DEFAULT_WIDTH;
export const SIDEBAR_MAX_WIDTH = MAX_WIDTH;
