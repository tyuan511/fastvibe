import { batchPolicy, prepareBatch, runBatch, summarizeBatch, type BatchInput, type ItemResult } from "../engine/decision/batch";
import { DecisionRuntime } from "../engine/decision/runtime";
import { readDecisionConfig } from "../engine/decision/store";
import { DecisionTraceFile } from "../engine/decision/trace";
import { getFastVibePaths } from "../engine/paths";
import { uiText } from "../engine/ui-text";
import { backendFor, trackDecisionWork } from "./decision-task-runner";

/**
 * The decision-engine scenario that is not a UI loop (docs/decision-layer.md §7.10):
 * `batch_decide` for the main agent. Its extension is a jiti module that cannot import
 * FastVibe, so it reaches Main through a global installed here, exactly like
 * `browser_task`. It re-reads `decision.json` on every call, so a switch flipped in
 * 设置 → 决策引擎 lands in running sessions without a restart.
 */

function config() {
  return readDecisionConfig(getFastVibePaths().decisionFile);
}

export function batchDecideEnabled(): boolean {
  const current = config();
  return current.kind === "jev" && current.batchDecide;
}

// ---------------------------------------------------------------------------
// batch_decide

export type BatchDecideResult =
  | {
      status: "ok";
      summary: { total: number; decided: number; review: number; failed: number };
      results: ItemResult[];
      backend: string;
      ms: number;
    }
  | { status: "error"; detail: string };

export async function runBatchDecide(
  input: BatchInput,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<BatchDecideResult> {
  const current = config();
  if (current.kind !== "jev" || !current.batchDecide) {
    return { status: "error", detail: uiText("批量决策已在设置中关闭。", "Batch decisions are switched off in Settings.") };
  }
  const prepared = prepareBatch(input);
  if (!prepared.ok) return { status: "error", detail: prepared.error };
  const backend = await backendFor(current);
  if (typeof backend === "string") return { status: "error", detail: backend };

  const started = Date.now();
  const stop = new AbortController();
  const release = trackDecisionWork(stop);
  const onAbort = () => stop.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const runtime = new DecisionRuntime({ backend, trace: new DecisionTraceFile(getFastVibePaths().decisionTraceFile) });
  const { batch } = prepared;
  const run = runtime.startRun({
    budgetKey: `batch:${started}`,
    deadlineAt: started + 5 * 60_000,
    maxRequests: batch.items.length * 3,
    signal: stop.signal,
  });
  try {
    const policy = batchPolicy(batch.minConfidence);
    const results = await runBatch(batch, (request) => run.decide(request, { policy }), {
      signal: stop.signal,
      onProgress: options.onProgress,
    });
    return { status: "ok", summary: summarizeBatch(results), results, backend: backend.id, ms: Date.now() - started };
  } finally {
    run.finish();
    release();
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Expose the scenario to its extension, which cannot import FastVibe internals. */
export function installDecisionScenarioGlobals(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__fastvibeBatchDecide = runBatchDecide;
  scope.__fastvibeBatchDecideEnabled = batchDecideEnabled;
}
