import { contextBridge, ipcRenderer } from "electron";
import { Ipc } from "@shared/ipc";
import { createFastVibeApi, type FastVibeApi } from "@shared/api";

/**
 * The Electron half of `window.fastvibe`.
 *
 * The bridge's shape lives in `@shared/api`, built once for every transport that can
 * carry it; this file only says how a desktop window reaches Main. The web client says
 * the same thing about a WebSocket (`renderer/src/remote/bridge.ts`), and because both
 * hand the renderer an object from the same factory, neither can quietly grow a method
 * the other lacks.
 */

const api = createFastVibeApi({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  subscribe: (channel, listener) => {
    const handler = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /**
   * Read synchronously, in the preload world, before the page's own scripts run — so
   * the renderer store can apply the theme on the first paint rather than flashing the
   * default one while an async call is in flight. `settings:get-sync` is the one method
   * with no counterpart on another transport, which is why it is read here and not
   * through the call table.
   */
  settingsInitial: (ipcRenderer.sendSync(Ipc.settingsGetSync) ?? {}) as Record<string, unknown>,
  /**
   * Handed over before paint too, so the shell decides whether it draws its own title
   * bar (`lib/platform.ts`) instead of guessing from the user agent.
   */
  platform: process.platform,
});

export type { FastVibeApi };

contextBridge.exposeInMainWorld("fastvibe", api);
