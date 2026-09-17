import { randomUUID } from "node:crypto";
import { uiText } from "../engine/ui-text";
import type { WebContents } from "electron";
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

/** Called by the browser-use extension running in the main process. */
export function requestBrowser(request: BrowserRequest): Promise<unknown> {
  if (!target || target.isDestroyed()) return Promise.reject(new Error(uiText("内置浏览器尚未打开", "Built-in browser is not open")));
  const id = randomUUID();
  const timeout = Math.max(1_000, Math.min(request.timeoutMs ?? 30_000, 120_000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(uiText(`浏览器操作超时（${timeout}ms）`, `Browser action timed out (${timeout}ms)`)));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    target?.send(Ipc.browserRequest, { id, request });
  });
}

const BIND_KEY = "__fastvibeBrowserConversationId";
let bindTail: Promise<unknown> = Promise.resolve();

/**
 * Stamp the conversation that is about to load `browser-use`, so the extension
 * factory can close over it. Factories run during `resourceLoader.reload()`, and
 * two sessions creating at once would otherwise share one mutating global.
 */
export function bindBrowserConversation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const run = bindTail.then(async () => {
    const g = globalThis as Record<string, unknown>;
    const previous = g[BIND_KEY];
    g[BIND_KEY] = conversationId;
    try {
      return await fn();
    } finally {
      g[BIND_KEY] = previous;
    }
  });
  bindTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Exposed for the resource-loaded extension without importing FastVibe internals. */
export function installBrowserGlobal(): void {
  (globalThis as Record<string, unknown>).__fastvibeBrowserRequest = requestBrowser;
}
