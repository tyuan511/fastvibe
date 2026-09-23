import { actionSpace } from "../engine/decision/browser-questions";
import { pageFingerprint, runBrowserAgent, StalePage, type AgentResult, type BrowserControl, type ObservedPage } from "../engine/decision/browser-agent";
import { guardScript, MARKER_SCRIPT, OBSERVE_SCRIPT, settleScript, targetScript, type ObservedAction } from "../engine/decision/browser-snapshot";
import { parseTextValue, riskOf, TEXT_VALUE_INSTRUCTIONS } from "../engine/decision/browser-task";
import { createJevBackend } from "../engine/decision/backends/jev";
import { createLayaBackend } from "../engine/decision/backends/laya";
import { acceptValid } from "../engine/decision/dispatch";
import { DecisionRuntime, type DecisionBackend } from "../engine/decision/runtime";
import { DecisionTraceFile } from "../engine/decision/trace";
import { readDecisionConfig } from "../engine/decision/store";
import { getFastVibePaths } from "../engine/paths";
import { loadProviderKeys } from "../engine/providers";
import { uiText } from "../engine/ui-text";
import { JEV_KEY_ENV, type DecisionModelConfig } from "@shared/decision";
import { requestBrowser } from "./browser-bridge";

/**
 * `browser_task`: the decision-model path of browser use (docs/decision-layer.md §7.2).
 *
 * The loop is `runBrowserAgent` (jev-ultrafast's); this file supplies its adapters — the
 * side pane's webview as the control layer, Jev or Laya as the decision backend, the
 * conversation's model with reasoning off as the field-text helper — plus what the
 * product adds around it: permission prompts for risky actions, and revocation when the
 * decision model is switched off or its key is cleared mid-run.
 */

export type BrowserTaskRequest = {
  conversationId?: string;
  goal: string;
  tabId?: string;
  signal?: AbortSignal;
  /** FASTVIBE_PERMISSION_MODE of the calling session. */
  mode?: string;
  /** Ask the user; resolves false when there is no UI to ask with. */
  confirm?: (message: string) => Promise<boolean>;
  onStep?: (line: string) => void;
};

export type BrowserTaskResult = {
  status: AgentResult["status"] | "denied" | "error";
  detail?: string;
  steps: Array<{ operation: string; action: string; text?: string | null; page_changed: boolean | null }>;
  page?: { url: string; title: string; text: string; elements: Array<{ index: string; label: string; role?: string; value?: string }> };
  backend: string;
  ms: number;
};

type Dependencies = {
  /** The conversation's own model, reasoning off, answering once outside the conversation. */
  completeText(conversationId: string, system: string, user: string, signal?: AbortSignal): Promise<string>;
};

let dependencies: Dependencies | null = null;
const running = new Set<AbortController>();

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

/** Ask before risky actions, per the calling session's permission mode (§7.5). */
function guardedControl(control: BrowserControl, request: BrowserTaskRequest, startUrl: () => string): BrowserControl {
  if (request.mode === "full") return control;
  let leftOriginConfirmed = false;
  return {
    ...control,
    async act(action, page, text) {
      const risk = riskOf(action, page, startUrl(), leftOriginConfirmed);
      if (risk) {
        const where = safeHost(page.url);
        const message = risk === "origin"
          ? uiText(`浏览器任务已离开起始网站，要在 ${where} 继续操作「${action.label}」吗？`, `The browser task left its starting site. Continue with "${action.label}" on ${where}?`)
          : uiText(`浏览器任务要在 ${where} 操作「${action.label}」`, `The browser task wants to use "${action.label}" on ${where}`);
        const approved = request.confirm ? await request.confirm(message) : false;
        if (!approved) throw new PermissionDenied(action.label);
        if (risk === "origin") leftOriginConfirmed = true;
      }
      return control.act(action, page, text);
    },
  };
}

class PermissionDenied extends Error {
  constructor(label: string) {
    super(uiText(`用户拒绝了操作「${label}」`, `The user declined "${label}"`));
    this.name = "PermissionDenied";
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function backendFor(config: DecisionModelConfig): Promise<DecisionBackend | string> {
  if (config.kind === "jev") {
    const key = (await loadProviderKeys(getFastVibePaths()))[JEV_KEY_ENV];
    if (!key) return uiText("还没有配置 Jev API key（设置 → 决策引擎）", "No Jev API key is configured (Settings → Decision engine)");
    return createJevBackend({ apiKey: key });
  }
  if (config.kind === "laya") return createLayaBackend({ baseUrl: config.baseUrl });
  return uiText("决策引擎未启用，请改用 browser_* 工具", "The decision engine is off; use the browser_* tools instead");
}

/** Whether sessions should be offered `browser_task` (read when a session's tools load). */
export function browserTaskEnabled(): boolean {
  return readDecisionConfig(getFastVibePaths().decisionFile).kind !== "off";
}

export async function runBrowserTask(request: BrowserTaskRequest): Promise<BrowserTaskResult> {
  const started = Date.now();
  const config = readDecisionConfig(getFastVibePaths().decisionFile);
  const backend = await backendFor(config);
  if (typeof backend === "string") return { status: "error", detail: backend, steps: [], backend: config.kind, ms: 0 };
  if (!dependencies) return { status: "error", detail: "browser_task is not installed", steps: [], backend: backend.id, ms: 0 };
  const deps = dependencies;
  const conversationId = request.conversationId;

  const stop = new AbortController();
  running.add(stop);
  const onAbort = () => stop.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const runtime = new DecisionRuntime({ backend, trace: new DecisionTraceFile(getFastVibePaths().decisionTraceFile) });
  const run = runtime.startRun({ budgetKey: `browser-task:${conversationId ?? "none"}:${started}`, deadlineAt: started + 5 * 60_000, signal: stop.signal });
  const base = webviewControl(conversationId, request.tabId);
  let startUrl = "";
  const control = guardedControl(base, request, () => startUrl);

  try {
    const first = await base.observe().catch(() => null);
    if (!first) {
      return { status: "error", detail: uiText("没有可操作的页面，请先用 browser_open 打开网址", "No page to work on; open one with browser_open first"), steps: [], backend: backend.id, ms: Date.now() - started };
    }
    startUrl = first.url;
    const result = await runBrowserAgent({
      goal: request.goal,
      control,
      run,
      policy: acceptValid("browser.step/jev-ultrafast-port"),
      fieldText: async (context) => parseTextValue(await deps.completeText(conversationId ?? "", TEXT_VALUE_INSTRUCTIONS, JSON.stringify(context), stop.signal)),
      onStep: (step) => request.onStep?.(`${step.step}. ${step.operation} ${step.action}${step.text ? ` = ${step.text}` : ""}`),
    });
    return summarize(result, backend.id, started);
  } catch (error) {
    if (error instanceof PermissionDenied) return { status: "denied", detail: error.message, steps: [], backend: backend.id, ms: Date.now() - started };
    return { status: "error", detail: error instanceof Error ? error.message : String(error), steps: [], backend: backend.id, ms: Date.now() - started };
  } finally {
    run.finish();
    running.delete(stop);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

function summarize(result: AgentResult, backend: string, started: number): BrowserTaskResult {
  const space = actionSpace(result.finalPage.actions);
  return {
    status: result.status,
    ...(result.detail ? { detail: result.detail } : {}),
    steps: result.steps.map((step) => ({ operation: step.operation, action: step.action, text: step.text ?? null, page_changed: step.page_changed })),
    page: {
      url: result.finalPage.url,
      title: result.finalPage.title,
      text: result.finalPage.text,
      elements: space.elements.map((element) => ({ index: element.index, label: element.label, role: element.role, value: element.value })),
    },
    backend,
    ms: Date.now() - started,
  };
}

/**
 * Stop every running task — the decision model was switched off or its key cleared.
 * Each loop ends at its next decision with `cancelled`; nothing already done is undone.
 */
export function revokeBrowserTasks(): void {
  for (const stop of running) stop.abort();
}

/** Expose the runner to the browser-use extension, which cannot import FastVibe internals. */
export function installBrowserTaskGlobal(deps: Dependencies): void {
  dependencies = deps;
  const scope = globalThis as Record<string, unknown>;
  scope.__fastvibeBrowserTask = runBrowserTask;
  scope.__fastvibeBrowserTaskEnabled = browserTaskEnabled;
}
