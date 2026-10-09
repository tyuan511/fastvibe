import { app, shell, type BrowserWindow } from "electron";
import { hostname } from "node:os";
import { DEFAULT_ACCOUNT_ORIGIN } from "@shared/account";
import { Ipc } from "@shared/ipc";
import { AccountService } from "./engine/account";
import { log } from "./engine/logger";
import { getFastVibePaths } from "./engine/paths";
import { broadcast } from "./ipc/broadcast";
import { handle } from "./ipc/registry";

/**
 * The site the account lives on. `FASTVIBE_CLOUD_URL` points a development build at a
 * local server; anything that is not a plain http(s) origin is ignored rather than
 * trusted, because the sign-in token is sent to whatever this names.
 */
function accountOrigin(): string {
  const raw = process.env.FASTVIBE_CLOUD_URL?.trim();
  if (!raw) return DEFAULT_ACCOUNT_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // fall through to the default
  }
  log.warn("FASTVIBE_CLOUD_URL is not an http(s) URL; using the default site");
  return DEFAULT_ACCOUNT_ORIGIN;
}

/** The name the site's device list shows for this machine. */
function deviceName(): string {
  return hostname().replace(/\.local$/i, "") || "FastVibe";
}

/**
 * Bring the app back in front once the browser has finished the sign-in.
 *
 * The person is looking at a browser tab; `window.focus()` alone cannot take an app that
 * is hidden or on another Space to the front, which is what `steal` is for. Same
 * gesture as clicking a notification.
 */
function raiseApp(windows: () => Iterable<BrowserWindow>, openWindow: () => void): void {
  if (process.platform === "darwin") app.focus({ steal: true });
  let target: BrowserWindow | undefined;
  for (const window of windows()) {
    if (window.isDestroyed()) continue;
    target = window;
    if (window.isFocused()) break;
  }
  if (!target) {
    openWindow();
    return;
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

export function registerAccount(
  windows: () => Iterable<BrowserWindow>,
  openWindow: () => void,
): AccountService {
  const service = new AccountService({
    file: getFastVibePaths().accountFile,
    origin: accountOrigin(),
    platform: process.platform,
    deviceName,
    openUrl: (url) => shell.openExternal(url),
    onChange: (state) => broadcast(Ipc.accountState, state),
    onSignedIn: () => raiseApp(windows, openWindow),
    log: (message) => log.warn(message),
  });

  handle(Ipc.accountGet, () => service.state());
  handle(Ipc.accountLogin, () => service.login());
  handle(Ipc.accountCancelLogin, () => service.cancelLogin());
  handle(Ipc.accountLogout, () => service.logout());

  // Who the token belongs to may have changed on the site, and a token may have been
  // revoked there; neither blocks the window, and a sign-in is shown from the file meanwhile.
  void service.refresh();
  return service;
}
