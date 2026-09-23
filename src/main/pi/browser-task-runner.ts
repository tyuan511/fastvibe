import { pageFingerprint, StalePage, type BrowserControl, type ObservedPage } from "../engine/decision/browser-agent";
import { guardScript, MARKER_SCRIPT, OBSERVE_SCRIPT, settleScript, targetScript, type ObservedAction } from "../engine/decision/browser-snapshot";
import { uiText } from "../engine/ui-text";
import { requestBrowser } from "./browser-bridge";
import { browserTasksEnabled, runDecisionTask, type DecisionTaskRequest, type DecisionTaskResult } from "./decision-task-runner";

/**
 * `browser_task`: the decision-model path of browser use (docs/decision-layer.md §7.2).
 *
 * The loop and everything around it live in `decision-task-runner.ts`; this file is the
 * control layer — the side pane's webview, or the system browser over CDP, both reached
 * through `requestBrowser`.
 */

export type BrowserTaskRequest = DecisionTaskRequest & { tabId?: string };
export type BrowserTaskResult = DecisionTaskResult;

/** Per-call ceilings: a page script on a document that navigates away never settles. */
const EVAL_LIMIT_MS = 15_000;
const SETTLE_LIMIT_MS = 1_000;

function webviewControl(conversationId: string | undefined, tabId: string | undefined): BrowserControl {
  const call = (action: string, params: Record<string, unknown> = {}, timeoutMs = EVAL_LIMIT_MS) =>
    requestBrowser({ action, conversationId, tabId, timeoutMs, ...params });
  const control: BrowserControl = {
    async observe(): Promise<ObservedPage> {
      await call("decision-wait-load").catch(() => undefined);
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          const observation = (await call("decision-eval", { script: OBSERVE_SCRIPT })) as Omit<ObservedPage, "fingerprint"> | null;
          if (observation) return { ...observation, fingerprint: pageFingerprint(observation) };
        } catch {
          // Navigating: the next attempt reads the new document.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        await call("decision-wait-load").catch(() => undefined);
      }
      throw new Error(uiText("页面一直没有稳定下来", "The page did not settle"));
    },
    async fresh(page, action) {
      try {
        if (action && (action.kind === "click" || action.kind === "select") && typeof action.node === "number") {
          const current = await call("decision-eval", { script: guardScript(action.node) });
          return JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[String(action.node)] ?? null]);
        }
        return JSON.stringify(await call("decision-eval", { script: MARKER_SCRIPT })) === JSON.stringify(page.marker);
      } catch {
        return false;
      }
    },
    async act(action: ObservedAction, page, text) {
      if (!(await control.fresh(page, action))) throw new StalePage();
      if (action.kind === "wait") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return;
      }
      if (action.kind === "scroll") await call("decision-wheel", { delta: action.delta ?? 560 });
      else {
        const target = (await call("decision-eval", { script: targetScript(action) })) as { x: number; y: number } | null;
        if (!target) {
          // A select that did not confirm may still have fired its change event.
          if (action.kind === "select") throw new Error(uiText("下拉选择未确认，请先检查页面", "The dropdown choice was not confirmed; inspect before retrying"));
          throw new StalePage(uiText("目标已变化或被遮挡", "The target changed or is covered"));
        }
        if (action.kind !== "select") {
          await call("decision-click", { x: target.x, y: target.y });
          if (action.kind === "fill") await call("decision-replace", { text: text ?? "" });
        }
      }
      await call("decision-eval", { script: settleScript(action) }, SETTLE_LIMIT_MS).catch(() => undefined);
      await call("decision-wait-load").catch(() => undefined);
    },
  };
  return control;
}

export function runBrowserTask(request: BrowserTaskRequest): Promise<BrowserTaskResult> {
  return runDecisionTask(request, {
    kind: "browser-task",
    control: webviewControl(request.conversationId, request.tabId),
    where: (page) => safeHost(page.url),
    missing: uiText("没有可操作的页面，请先用 browser_open 打开网址", "No page to work on; open one with browser_open first"),
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Expose the runner to the browser-use extension, which cannot import FastVibe internals. */
export function installBrowserTaskGlobal(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__fastvibeBrowserTask = runBrowserTask;
  scope.__fastvibeBrowserTaskEnabled = browserTasksEnabled;
}
