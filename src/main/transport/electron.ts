import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { Ipc } from "@shared/ipc";
import type { AppServer } from "../app-server/app-server.ts";
import { log } from "../engine/logger.ts";
import { attachWindowSession, windowOrigin, type WindowSession } from "./window-session.ts";

export { windowOrigin };

/**
 * Channels the renderer *sends* rather than *invokes*: no reply, so they are wired
 * with `ipcMain.on`. They are in the same table as everything else because the remote
 * transport has no such distinction — it is an Electron detail, not a method's nature.
 *
 * `settings:get-sync` is deliberately not here: `sendSync` has no counterpart on another
 * transport, and the preload reads it before first paint. Index keeps that handler.
 */
export const ELECTRON_SEND_ONLY = new Set<string>([Ipc.browserResponse, Ipc.appLog]);

/**
 * Adapt the existing per-channel preload (`ipcRenderer.invoke` / `send`) onto one
 * AppServer, using an in-process AppClient session per window with a trusted
 * `window` + `origin`.
 *
 * Index no longer per-window `subscribe()`s onto `broadcast`. Pushes reach the
 * renderer through the session's `onPush` → `webContents.send`, once.
 */
export function wireElectronAppTransport(appServer: AppServer): void {
  const bindings = new Map<number, WindowSession>();

  const bind = (sender: WebContents): WindowSession => {
    const existing = bindings.get(sender.id);
    if (existing) return existing;

    const window = BrowserWindow.fromWebContents(sender);
    const attached = attachWindowSession(appServer, {
      origin: windowOrigin(sender.id),
      window,
      isClosed: () => sender.isDestroyed(),
      sendToRenderer: (channel, payload) => {
        if (sender.isDestroyed()) return;
        sender.send(channel, payload);
      },
    });

    const dispose = (): void => {
      if (!bindings.delete(sender.id)) return;
      attached.dispose();
    };
    sender.once("destroyed", dispose);

    const binding: WindowSession = { ...attached, dispose };
    bindings.set(sender.id, binding);
    return binding;
  };

  const invoke = async (sender: WebContents, channel: string, payload: unknown): Promise<unknown> => {
    const binding = bind(sender);
    return binding.call(channel, payload);
  };

  for (const channel of appServer.channels()) {
    if (ELECTRON_SEND_ONLY.has(channel)) {
      ipcMain.on(channel, (event, payload: unknown) => {
        void invoke(event.sender, channel, payload).catch((error: unknown) => {
          log.warn(`ipc send failed channel=${channel}: ${String(error)}`);
        });
      });
      continue;
    }
    ipcMain.handle(channel, (event, payload: unknown) => invoke(event.sender, channel, payload));
  }

  app.on("browser-window-created", (_event, window) => {
    bind(window.webContents);
  });
}
