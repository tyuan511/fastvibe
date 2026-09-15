import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { Ipc } from "@shared/ipc";

/** The small, JSON-serialisable protocol shared by the browser-use extension and renderer. */
export type BrowserRequest = {
  action: string;
  tabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  script?: string;
  timeoutMs?: number;
};

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
      request.reject(new Error("浏览器窗口已关闭"));
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
  else request.reject(new Error(response.error || "浏览器操作失败"));
}

/** Called by the browser-use extension running in the main process. */
export function requestBrowser(request: BrowserRequest): Promise<unknown> {
  if (!target || target.isDestroyed()) return Promise.reject(new Error("内置浏览器尚未打开"));
  const id = randomUUID();
  const timeout = Math.max(1_000, Math.min(request.timeoutMs ?? 30_000, 120_000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`浏览器操作超时（${timeout}ms）`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    target?.send(Ipc.browserRequest, { id, request });
  });
}

/** Exposed for the resource-loaded extension without importing FastVibe internals. */
export function installBrowserGlobal(): void {
  (globalThis as Record<string, unknown>).__fastvibeBrowserRequest = requestBrowser;
}
