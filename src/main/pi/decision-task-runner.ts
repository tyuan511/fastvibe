import { actionSpace } from "../engine/decision/browser-questions";
import { runBrowserAgent, type AgentResult, type BrowserControl, type ObservedPage } from "../engine/decision/browser-agent";
import { parseTextValue, riskOf, TEXT_VALUE_INSTRUCTIONS } from "../engine/decision/browser-task";
import { createJevBackend } from "../engine/decision/backends/jev";
import { acceptValid } from "../engine/decision/dispatch";
import { DecisionRuntime, type DecisionBackend } from "../engine/decision/runtime";
import { DecisionTraceFile } from "../engine/decision/trace";
import { readDecisionConfig } from "../engine/decision/store";
import { getFastVibePaths } from "../engine/paths";
import { loadProviderKeys } from "../engine/providers";
import { uiText } from "../engine/ui-text";
import { JEV_KEY_ENV, type DecisionModelConfig } from "@shared/decision";

/**
 * What `browser_task` and `computer_task` share (docs/decision-layer.md §7): the
 * decision-model loop (`runBrowserAgent`, jev-ultrafast's), wrapped with the parts that
 * do not depend on what is being driven — which backend decides, the field-text helper,
 * permission prompts for risky actions, revocation, and the result the tool returns.
 * Each tool brings only its control layer.
 */

export type DecisionTaskRequest = {
  conversationId?: string;
  goal: string;
  signal?: AbortSignal;
  /** FASTVIBE_PERMISSION_MODE of the calling session. */
  mode?: string;
  /** Ask the user; resolves false when there is no UI to ask with. */
  confirm?: (message: string) => Promise<boolean>;
  onStep?: (line: string) => void;
};

export type DecisionTaskResult = {
  status: AgentResult["status"] | "denied" | "error";
  detail?: string;
  steps: Array<{ operation: string; action: string; text?: string | null; page_changed: boolean | null }>;
  page?: { url: string; title: string; text: string; elements: Array<{ index: string; label: string; role?: string; value?: string }> };
  backend: string;
  ms: number;
};

export type DecisionTaskDependencies = {
  /** The conversation's own model, reasoning off, answering once outside the conversation. */
  completeText(conversationId: string, system: string, user: string, signal?: AbortSignal): Promise<string>;
};

let dependencies: DecisionTaskDependencies | null = null;
const running = new Set<AbortController>();

export function installDecisionTaskDependencies(deps: DecisionTaskDependencies): void {
  dependencies = deps;
}

/** Whether sessions should be offered `browser_task` (read when a session's tools load). */
export function browserTasksEnabled(): boolean {
  const config = readDecisionConfig(getFastVibePaths().decisionFile);
  return config.kind === "jev" && config.browserControl;
}

/** Whether sessions should be offered `computer_task` (read when a session's tools load). */
export function computerTasksEnabled(): boolean {
  const config = readDecisionConfig(getFastVibePaths().decisionFile);
  return config.kind === "jev" && config.computerControl;
}

/**
 * Stop every running task — the decision model was switched off or its key cleared.
 * Each loop ends at its next decision with `cancelled`; nothing already done is undone.
 */
export function revokeDecisionTasks(): void {
  for (const stop of running) stop.abort();
}

export class PermissionDenied extends Error {
  constructor(label: string) {
    super(uiText(`用户拒绝了操作「${label}」`, `The user declined "${label}"`));
    this.name = "PermissionDenied";
  }
}

async function backendFor(config: DecisionModelConfig): Promise<DecisionBackend | string> {
  if (config.kind === "jev") {
    const key = (await loadProviderKeys(getFastVibePaths()))[JEV_KEY_ENV];
    if (!key) return uiText("还没有配置 Jev API key（设置 → 决策引擎）", "No Jev API key is configured (Settings → Decision engine)");
    return createJevBackend({ apiKey: key });
  }
  return uiText("决策引擎未启用，请改用逐步操作的工具", "The decision engine is off; use the step-by-step tools instead");
}

/** Ask before risky actions, per the calling session's permission mode (§7.5). */
function guardedControl(control: BrowserControl, request: DecisionTaskRequest, startUrl: () => string, where: (page: ObservedPage) => string): BrowserControl {
  if (request.mode === "full") return control;
  let leftOriginConfirmed = false;
  return {
    ...control,
    async act(action, page, text) {
      const risk = riskOf(action, page, startUrl(), leftOriginConfirmed);
      if (risk) {
        const place = where(page);
        const message = risk === "origin"
          ? uiText(`任务已离开起始网站，要在 ${place} 继续操作「${action.label}」吗？`, `The task left its starting site. Continue with "${action.label}" on ${place}?`)
          : uiText(`任务要在 ${place} 操作「${action.label}」`, `The task wants to use "${action.label}" on ${place}`);
        const approved = request.confirm ? await request.confirm(message) : false;
        if (!approved) throw new PermissionDenied(action.label);
        if (risk === "origin") leftOriginConfirmed = true;
      }
      return control.act(action, page, text);
    },
  };
}

export type DecisionTaskTarget = {
  /** Trace budget key prefix, e.g. `browser-task`. */
  kind: string;
  control: BrowserControl;
  /** How a page is named in a permission prompt (a host, an app). */
  where(page: ObservedPage): string;
  /** Said when there is nothing to observe yet. */
  missing: string;
};

export async function runDecisionTask(request: DecisionTaskRequest, target: DecisionTaskTarget): Promise<DecisionTaskResult> {
  const started = Date.now();
  const config = readDecisionConfig(getFastVibePaths().decisionFile);
  const backend = await backendFor(config);
  if (typeof backend === "string") return { status: "error", detail: backend, steps: [], backend: config.kind, ms: 0 };
  if (!dependencies) return { status: "error", detail: `${target.kind} is not installed`, steps: [], backend: backend.id, ms: 0 };
  const deps = dependencies;
  const conversationId = request.conversationId;

  const stop = new AbortController();
  running.add(stop);
  const onAbort = () => stop.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const runtime = new DecisionRuntime({ backend, trace: new DecisionTraceFile(getFastVibePaths().decisionTraceFile) });
  const run = runtime.startRun({ budgetKey: `${target.kind}:${conversationId ?? "none"}:${started}`, deadlineAt: started + 5 * 60_000, signal: stop.signal });
  let startUrl = "";
  const control = guardedControl(target.control, request, () => startUrl, target.where);

  try {
    const first = await target.control.observe().catch(() => null);
    if (!first) return { status: "error", detail: target.missing, steps: [], backend: backend.id, ms: Date.now() - started };
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

function summarize(result: AgentResult, backend: string, started: number): DecisionTaskResult {
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
