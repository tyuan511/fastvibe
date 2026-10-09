/**
 * Which shell the renderer is running in, and what that shell draws for itself: the
 * platform's modifier keys, whether macOS's traffic lights or a custom title bar are
 * there. The renderer only ever runs inside the desktop window (or the browser preview
 * harness), so the host platform is the answer to all of them.
 */

/**
 * The host Main runs on, from the bridge.
 *
 * The user-agent fallback only exists for the browser preview harness, which installs a
 * fixture `window.fastvibe` of its own.
 */
function detectPlatform(): string {
  const fromShell = window.fastvibe?.app?.platform;
  if (typeof fromShell === "string" && fromShell.length > 0) return fromShell;
  return platformFromAgent();
}

function platformFromAgent(): string {
  const agent = navigator.userAgent;
  if (/mac/i.test(agent)) return "darwin";
  if (/win/i.test(agent)) return "win32";
  return "linux";
}

export const APP_PLATFORM = detectPlatform();

/** macOS keys: ⌘ rather than Ctrl. Not a statement about the window. */
export const IS_MAC = APP_PLATFORM === "darwin";

/**
 * Whether macOS's traffic lights are overlaid on the app's own first row
 * (`hiddenInset`), which is what the rows that start with `pl-22` are insetting around.
 *
 * Only ever true in a desktop window on macOS.
 */
export const HAS_TRAFFIC_LIGHTS = APP_PLATFORM === "darwin";

/**
 * Whether the window can be drawn over the OS blur: the packaged macOS shell, whose Main
 * turns vibrancy on while 玻璃效果 is on. The browser preview harness reports `darwin` too
 * but is a plain page with nothing behind it, so a translucent theme there would just wash
 * out — it is told apart by not being Electron. The one exception is the harness's
 * desktop scene (`?desktop=1`), which paints a wallpaper and a stand-in for the material
 * itself, and says so on the bridge.
 */
export const HAS_VIBRANCY =
  HAS_TRAFFIC_LIGHTS &&
  (/Electron\//.test(navigator.userAgent) ||
    (window.fastvibe?.app as { simulatedVibrancy?: boolean } | undefined)?.simulatedVibrancy === true);

/**
 * Windows and Linux have no traffic lights to inset, and a native title bar above
 * an app that already has its own top row reads as two bars. So there the window is
 * frameless and `components/layout/title-bar.tsx` draws the whole bar: the brand,
 * the sidebar's own controls, and minimise / maximise / close. Everything the macOS
 * layout fits into the traffic lights' row — the sidebar's title row and the
 * logo row under it — moves up into that bar instead.
 */
export const HAS_CUSTOM_TITLE_BAR = APP_PLATFORM !== "darwin";

/**
 * A touchscreen with no mouse: a phone or tablet. Asked at the moment of use rather than
 * at load, because a tablet can gain a trackpad mid-session. This is the same condition
 * the CSS keys its touch rules on (`index.css`), so the two cannot disagree.
 */
export function isTouchOnly(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
