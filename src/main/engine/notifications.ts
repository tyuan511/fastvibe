import { Notification, app, type BrowserWindow } from "electron";
import type { NotificationRequest } from "@shared/notifications";
import { readAppSettings } from "./app-settings";
import { getFastVibePaths } from "./paths";

/**
 * 系统通知 — the Electron half: raising a notice and answering its click.
 *
 * Everything that can be decided without Electron lives in `@shared/notifications`, so it
 * can be unit-tested. What is left here needs a real `Notification` and a real window:
 * showing the notice, and — the point of it — taking a click as a request to be put in
 * front of the conversation that caused it.
 *
 * The engine only reports *what happened*; Main decides whether the user is in front of
 * the app already and whether this scenario is switched on.
 */

/** The settings bag Main reads for a notice, or `{}` when the file has none yet. */
export function readNotificationSettings(): Record<string, unknown> {
  return readAppSettings(getFastVibePaths());
}

/**
 * Raise one notice and wire its click.
 *
 * The jump is not re-implemented here: setting the conversation active in Main's catalog
 * is the same thing a click in the sidebar does, and every client already follows it
 * (`workspace:changed` → `handleOpen`), so a second window — or a phone over remote
 * access — ends up looking at the same chat instead of a transcript that disagrees with
 * the notification that was just dismissed. It is also what makes this correct when the
 * window was *closed*: the window that comes back adopts the catalog's active
 * conversation as it boots.
 *
 * `openConversation` is optional because not every notice is about a chat — an update
 * that finished downloading only has a window to bring forward.
 */
export function presentNotification(
  request: NotificationRequest,
  options: {
    windows: () => Iterable<BrowserWindow>;
    /** Create the window when none is open (macOS keeps the app alive with none). */
    createWindow: () => void;
    openConversation?: (id: string) => Promise<unknown>;
  },
): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: request.title, body: request.body });
  notification.on("click", () => {
    if (process.platform === "darwin") {
      // `window.focus()` alone cannot lift an app that is hidden (⌘H) or sitting on
      // another Space back to the front; the notification click is an explicit request
      // to be taken there, which is exactly what `steal` is for.
      app.focus({ steal: true });
    }
    let target: BrowserWindow | undefined;
    for (const window of options.windows()) {
      if (window.isDestroyed()) continue;
      target = window;
      if (window.isFocused()) break;
    }
    if (!target) options.createWindow();
    else {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    }
    if (!request.conversationId || !options.openConversation) return;
    void options.openConversation(request.conversationId).catch(() => undefined);
  });
  notification.show();
}
