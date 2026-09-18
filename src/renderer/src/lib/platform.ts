/**
 * Which shell the renderer is running in, and what that shell draws for itself.
 *
 * Two different questions hide behind "is this a Mac", and the remote client is what
 * separates them:
 *
 * - *Which keyboard is at this screen.* The browser reports the keys it actually
 *   receives, so ⌘ versus Ctrl follows the device the person is typing on — not the
 *   machine the agent runs on.
 * - *What window chrome is around this page.* A browser tab has none, whatever the host
 *   platform is. A client connected to a Mac that read `darwin` and inset its first row
 *   for traffic lights left 88px of blank space before the sidebar's own buttons, with
 *   nothing in it.
 */

/** True in the web client: a browser talking to a host over the remote server. */
export const IS_REMOTE = window.fastvibe?.app?.remote === true;

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

/**
 * The platform whose modifier keys this screen sends.
 *
 * The host's for a desktop window, and this device's own for a browser: an iPad
 * connected to a Linux box still sends ⌘, and a Windows laptop connected to a Mac
 * still sends Ctrl. Shortcut labels and chord matching (`lib/shortcuts.ts`) are about
 * the keyboard in front of the person, so they read this rather than `APP_PLATFORM`.
 */
export const KEYBOARD_PLATFORM = IS_REMOTE ? platformFromAgent() : APP_PLATFORM;

/** macOS keys: ⌘ rather than Ctrl. Not a statement about the window. */
export const IS_MAC = KEYBOARD_PLATFORM === "darwin";

/**
 * Whether macOS's traffic lights are overlaid on the app's own first row
 * (`hiddenInset`), which is what the rows that start with `pl-22` are insetting around.
 *
 * Only ever true in a desktop window on macOS. A browser has no traffic lights to
 * inset, so the remote client draws the same first row flush.
 */
export const HAS_TRAFFIC_LIGHTS = !IS_REMOTE && APP_PLATFORM === "darwin";

/**
 * Windows and Linux have no traffic lights to inset, and a native title bar above
 * an app that already has its own top row reads as two bars. So there the window is
 * frameless and `components/layout/title-bar.tsx` draws the whole bar: the brand,
 * the sidebar's own controls, and minimise / maximise / close. Everything the macOS
 * layout fits into the traffic lights' row — the sidebar's title row and the
 * logo row under it — moves up into that bar instead.
 *
 * Never in the remote client: that bar's window controls call `window:*` methods the
 * remote policy denies, on a window this page does not have. The browser keeps the
 * macOS arrangement — the sidebar's own first row — minus the inset.
 */
export const HAS_CUSTOM_TITLE_BAR = !IS_REMOTE && APP_PLATFORM !== "darwin";
