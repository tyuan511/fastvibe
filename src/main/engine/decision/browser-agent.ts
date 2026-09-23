import { createHash } from "node:crypto";
import { buildBrowserStep, resolveDecision, type StepHistoryEntry } from "./browser-questions.ts";
import type { DecisionObservation, ObservedAction } from "./browser-snapshot.ts";
import { fieldContext, MAX_ACTIONS, MAX_DECISIONS, noProgress } from "./browser-task.ts";
import type { AdoptionPolicy } from "./dispatch.ts";
import type { DecisionRun } from "./runtime.ts";

/**
 * The browser-use loop: goal → observe → decide → act → observe, until DONE or BLOCKED.
 *
 * A port of browser-use/jev-ultrafast `agent.py` (commit 1231850, MIT License,
 * Copyright (c) 2026 Browser Use). What it is built from is injected, so the loop itself
 * is the architecture and the rest are adapters (docs/decision-layer.md §7):
 *
 * - `control` — the control layer: observing and acting on a real page (the side pane's
 *   webview in the product). The only part that is not jev-ultrafast's.
 * - `run` — a decision run on the decision layer, whose backend answers the questions:
 *   a decision model such as Jev. A large model does not run this loop: with no
 *   decision model selected, browser use stays on the `browser_*` tools the main agent
 *   drives itself, which suits a model that plans and reads better than per-step choices.
 * - `fieldText` — the helper that writes a field's value when TYPE_TEXT is chosen.
 *
 * The loop only acts. It does not read answers off the page; whoever asked for the task
 * does that from the final observation.
 */

export class StalePage extends Error {
  constructor(message = "Page changed since this decision. Observe again.") {
    super(message);
    this.name = "StalePage";
  }
}

export type ObservedPage = DecisionObservation & { fingerprint: string };

/** Everything the loop needs from a browser. Implementations throw `StalePage` from `act`. */
export type BrowserControl = {
  observe(): Promise<ObservedPage>;
  /** Scoped freshness for click/select, full semantic freshness otherwise. */
  fresh(page: ObservedPage, action?: ObservedAction): Promise<boolean>;
  act(action: ObservedAction, page: ObservedPage, text?: string): Promise<void>;
};

/** jev-ultrafast's page fingerprint: what changed, for `page_changed`. */
export function pageFingerprint(page: DecisionObservation): string {
  const content = { url: page.url, text: page.text, actions: page.actions, scroll: page.scroll };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export type AgentStep = StepHistoryEntry & { step: number; operation: string; decisionMs: number; textMs?: number };

export type AgentResult = {
  status: "done" | "blocked" | "no_progress" | "handed_off" | "exhausted" | "cancelled" | "missing_value";
  detail?: string;
  steps: AgentStep[];
  decisions: number;
  staleDecisions: number;
  finalPage: ObservedPage;
};

export type BrowserAgentOptions = {
  goal: string;
  control: BrowserControl;
  run: DecisionRun;
  policy: AdoptionPolicy;
  /** Returns the value to type, or `null` when the goal does not supply one. */
  fieldText(context: ReturnType<typeof fieldContext>): Promise<string | null>;
  onStep?(step: AgentStep): void;
  maxActions?: number;
  maxDecisions?: number;
  /**
   * Page-settling after an action: poll interval, how long a changed page must stay
   * unchanged, how long to wait for a late change, hard cap.
   */
  settle?: { intervalMs?: number; stableMs?: number; quietMs?: number; maxMs?: number };
};

const SETTLE_INTERVAL_MS = 100;
const SETTLE_STABLE_MS = 300;
const SETTLE_QUIET_MS = 600;
const SETTLE_MAX_MS = 2_000;

/**
 * Observe after an action until the page has stopped changing.
 *
 * A single read right after a click catches a single-page app mid-transition: GitHub
 * changes the URL first and swaps the listing in afterwards, so the next decision saw
 * the old listing and clicked the same link again — harmless on a directory link, a
 * second submission on a form. Two identical reads are not enough either: the
 * half-loaded state can itself last a few reads. So a page that changed is read until it
 * has held still for `stableMs`; a page that has not changed yet is given `quietMs` for a
 * late update; nothing waits past `maxMs`.
 */
async function settledObservation(
  control: BrowserControl,
  before: ObservedPage,
  options: BrowserAgentOptions["settle"] = {},
): Promise<ObservedPage> {
  const interval = options.intervalMs ?? SETTLE_INTERVAL_MS;
  const stable = options.stableMs ?? SETTLE_STABLE_MS;
  const quiet = options.quietMs ?? SETTLE_QUIET_MS;
  const started = Date.now();
  const deadline = started + (options.maxMs ?? SETTLE_MAX_MS);
  let last = await control.observe();
  let lastChange = last.fingerprint !== before.fingerprint ? Date.now() : undefined;
  for (;;) {
    const now = Date.now();
    if (lastChange === undefined && now - started >= quiet) return last;
    if (lastChange !== undefined && now - lastChange >= stable) return last;
    if (now + interval > deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
    const next = await control.observe();
    if (next.fingerprint !== last.fingerprint) lastChange = Date.now();
    last = next;
  }
}

export async function runBrowserAgent(options: BrowserAgentOptions): Promise<AgentResult> {
  const { goal, control, run, policy } = options;
  const maxActions = options.maxActions ?? MAX_ACTIONS;
  const maxDecisions = options.maxDecisions ?? MAX_DECISIONS;
  const steps: AgentStep[] = [];
  let decisions = 0;
  let staleDecisions = 0;
  // A generated value is reused only while the helper's whole input is identical, and is
  // dropped after a successful mutation — so a stale re-decision does not pay for it twice.
  let pendingText = null as { key: string; text: string } | null;
  let page = await control.observe();

  const finish = (status: AgentResult["status"], detail?: string): AgentResult => ({
    status,
    ...(detail ? { detail } : {}),
    steps,
    decisions,
    staleDecisions,
    finalPage: page,
  });

  for (;;) {
    if (decisions >= maxDecisions) return finish("exhausted", "decision budget");
    if (steps.length >= maxActions) return finish("exhausted", "action budget");
    if (!(await control.fresh(page))) page = await control.observe();

    const step = buildBrowserStep({ goal, observation: page, history: steps });
    decisions++;
    const decisionStarted = Date.now();
    const outcome = await run.decide(step.request, { policy });
    const decisionMs = Date.now() - decisionStarted;
    if (outcome.status === "cancelled") return finish("cancelled");
    if (outcome.status === "exhausted") return finish("exhausted", outcome.reason);
    if (outcome.status === "handoff") return finish("handed_off", `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}`);

    const { operation, action } = resolveDecision(step, outcome.answers);
    if (operation === "DONE" || operation === "BLOCKED") {
      // A terminal choice about a page that has since changed is not about this page.
      if (!(await control.fresh(page))) {
        staleDecisions++;
        page = await control.observe();
        continue;
      }
      return finish(operation === "DONE" ? "done" : "blocked");
    }
    if (!action) return finish("handed_off", `no executable action for ${operation}`);

    let text: string | undefined;
    let textMs: number | undefined;
    try {
      if (action.kind === "fill") {
        if (!(await control.fresh(page))) throw new StalePage("Page changed before text generation.");
        const context = fieldContext(goal, action, page, steps);
        const key = JSON.stringify(context);
        if (pendingText?.key === key) text = pendingText.text;
        else {
          const reserved = run.reserve();
          if (!("ok" in reserved)) return finish(reserved.status === "cancelled" ? "cancelled" : "exhausted");
          const textStarted = Date.now();
          const value = await options.fieldText(context);
          textMs = Date.now() - textStarted;
          if (value === null) return finish("missing_value", action.label);
          text = value;
          pendingText = { key, text };
        }
      }
      await control.act(action, page, text);
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
      staleDecisions++;
      page = await control.observe();
      continue;
    }
    pendingText = null;

    // Record the execution before observing: a failed observation must not erase it.
    const entry: AgentStep = {
      step: steps.length + 1,
      operation,
      action: action.label,
      kind: action.kind,
      text: text ?? null,
      page_changed: null,
      decisionMs,
      ...(textMs !== undefined ? { textMs } : {}),
    };
    steps.push(entry);
    const next = action.kind === "wait" ? await control.observe() : await settledObservation(control, page, options.settle);
    entry.page_changed = next.fingerprint !== page.fingerprint;
    page = next;
    options.onStep?.(entry);
    if (noProgress(steps)) return finish("no_progress", "the last three actions left the page unchanged");
  }
}
