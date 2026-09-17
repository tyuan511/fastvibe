/**
 * Which desktop the shell is running on.
 *
 * The preload hands over Node's `process.platform` before the first paint, so the
 * layout that depends on it (the whole window chrome, below) never flashes through
 * the wrong branch. The user-agent fallback only exists for the browser preview
 * harness, which installs a fixture `window.fastvibe` of its own.
 */
function detectPlatform(): string {
  const fromShell = window.fastvibe?.app?.platform;
  if (typeof fromShell === "string" && fromShell.length > 0) return fromShell;
  const agent = navigator.userAgent;
  if (/mac/i.test(agent)) return "darwin";
  if (/win/i.test(agent)) return "win32";
  return "linux";
}

export const APP_PLATFORM = detectPlatform();

/** macOS: its traffic lights are inset into the app's own first row (`hiddenInset`). */
export const IS_MAC = APP_PLATFORM === "darwin";

/**
 * Windows and Linux have no traffic lights to inset, and a native title bar above
 * an app that already has its own top row reads as two bars. So there the window is
 * frameless and `components/layout/title-bar.tsx` draws the whole bar: the brand,
 * the sidebar's own controls, and minimise / maximise / close. Everything the macOS
 * layout fits into the traffic lights' row — the sidebar's title row and the
 * logo row under it — moves up into that bar instead.
 */
export const HAS_CUSTOM_TITLE_BAR = !IS_MAC;
