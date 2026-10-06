import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { uiText } from "../engine/ui-text";
import { readAppSettings } from "../engine/app-settings";
import { runBrowserCdp } from "../engine/browser-cdp";
import { getFastVibePaths } from "../engine/paths";
import { app, type WebContents } from "electron";
import { Ipc } from "@shared/ipc";
import type { BrowserRequest } from "@shared/types";

/** The protocol shared by the browser-use extension and the renderer. */
export type { BrowserRequest };

type BrowserResponse = { id: string; ok: boolean; result?: unknown; error?: string };

let target: WebContents | null = null;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

/** Attach the current renderer window. Browser requests are intentionally scoped to it. */
export function attachBrowserRenderer(contents: WebContents): void {
  target = contents;
  contents.once("destroyed", () => {
    if (target === contents) target = null;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error(uiText("浏览器窗口已关闭", "Browser window closed")));
      pending.delete(id);
    }
  });
}

export function respondBrowserRequest(response: BrowserResponse): void {
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  clearTimeout(request.timer);
  if (response.ok) request.resolve(response.result);
  else request.reject(new Error(response.error || uiText("浏览器操作失败", "Browser action failed")));
}

/**
 * Whether browser-use should drive the system browser. Read per call, the same way
 * the computer-use switch is, so flipping it takes effect on the next tool call
 * rather than the next launch.
 */
function useSystemBrowser(): boolean {
  try {
    return readAppSettings(getFastVibePaths()).browserUseSystem === true;
  } catch {
    return false;
  }
}

/**
 * Called by the browser-use extension running in the main process.
 *
 * `signal` is the tool call's own: a Stop must end the wait at once. The page may be
 * what is stuck (a guest that died mid-call never answers), and without this the call
 * ran out its whole budget — up to 45s — while the engine's stop gave up after 15s and
 * reported 「停止运行超时」 for a run that was in fact just waiting on a dead tab.
 */
export function requestBrowser(request: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (useSystemBrowser()) {
    const profileDir = join(getFastVibePaths().runtimeRoot, "browser-profile");
    return untilAborted(runBrowserCdp(request, profileDir), signal);
  }
  if (!target || target.isDestroyed()) return Promise.reject(new Error(uiText("内置浏览器尚未打开", "Built-in browser is not open")));
  const id = randomUUID();
  const timeout = Math.max(1_000, Math.min(request.timeoutMs ?? 30_000, 120_000));
  return new Promise((resolve, reject) => {
    const settle = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      pending.delete(id);
      settle();
      reject(new Error(uiText(`浏览器操作超时（${timeout}ms）`, `Browser action timed out (${timeout}ms)`)));
    }, timeout);
    pending.set(id, {
      resolve: (value) => { settle(); resolve(value); },
      reject: (error) => { settle(); reject(error); },
      timer,
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    target?.send(Ipc.browserRequest, { id, request });
  });
}

function abortError(): Error {
  return new Error(uiText("已中止", "Aborted"));
}

/** Stop waiting on `work` the moment `signal` fires; the work itself is left to finish alone. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Exposed for the resource-loaded extension without importing FastVibe internals. */
export function installBrowserGlobal(): void {
  (globalThis as Record<string, unknown>).__fastvibeBrowserRequest = requestBrowser;
}

/**
 * A guest's popup is never a window this app wants, and Electron's default is to make
 * one anyway.
 *
 * A page in the side pane opens a popup the ordinary way — `window.open`, or a
 * `target="_blank"` link, which the injected click runs like any other click — and an
 * unhandled window-open is answered by *creating a BrowserWindow*: a chrome-less guest
 * no pane owns, shown in front of whatever the user was doing. During a browser-use run
 * that is the app interrupting them from the background, with nothing on screen to
 * explain it and no way for the pane to list or close what appeared.
 *
 * Denying it turns the popup into what the model meant by clicking the link: the page it
 * points at, loaded in the tab that was already being driven. The tab id the model holds
 * stays valid, `browser_back` returns, and the pane's own `did-navigate` listener keeps
 * the tab's title and remembered URL in step — so a recovery resumes the popup page, not
 * the one it was opened from.
 *
 * Only an addressed page is followed. Every other scheme carries no address of its own
 * (`about:blank` is a page its opener means to write into itself) or is a hand-off to
 * another program (`mailto:`), which is the same interruption through a different door.
 */
export function guardGuestPopups(): void {
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    contents.setWindowOpenHandler((details) => {
      if (/^https?:\/\//i.test(details.url)) void contents.loadURL(details.url).catch(() => undefined);
      return { action: "deny" };
    });
  });
}
