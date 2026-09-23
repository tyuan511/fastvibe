import { approvalPolicy, approvalVerdict, buildApprovalRequest, type ApprovalCall, type ApprovalVerdict } from "../engine/decision/approval";
import { batchPolicy, prepareBatch, runBatch, summarizeBatch, type BatchInput, type ItemResult } from "../engine/decision/batch";
import { canonicalize } from "../engine/decision/protocol";
import { DecisionRuntime } from "../engine/decision/runtime";
import { readDecisionConfig } from "../engine/decision/store";
import { DecisionTraceFile } from "../engine/decision/trace";
import { log } from "../engine/logger";
import { getFastVibePaths } from "../engine/paths";
import { uiText } from "../engine/ui-text";
import { backendFor, trackDecisionWork } from "./decision-task-runner";

/**
 * The two decision-engine scenarios that are not a UI loop (docs/decision-layer.md
 * §7.10–7.11): `batch_decide` for the main agent, and the 帮我批准 judgement for the
 * permission sandbox. Both extensions are jiti modules that cannot import FastVibe, so
 * each reaches Main through a global installed here, exactly like `browser_task`.
 * Both re-read `decision.json` on every call, so a switch flipped in 设置 → 决策引擎
 * lands in running sessions without a restart.
 */

function config() {
  return readDecisionConfig(getFastVibePaths().decisionFile);
}

export function batchDecideEnabled(): boolean {
  const current = config();
  return current.kind === "jev" && current.batchDecide;
}

export function approvalJudgeEnabled(): boolean {
  const current = config();
  return current.kind === "jev" && current.smartApproval;
}

// ---------------------------------------------------------------------------
// 帮我批准

/**
 * The judgement sits in front of every shell command in 帮我批准 mode, so a slow answer
 * is paid on each one. It gets one quick retry inside a few seconds, and after a failure
 * to reach the service at all the sandbox's rules decide alone for a minute — a network
 * that is down must not add a timeout to every command.
 */
const APPROVAL_TIMEOUT_MS = 3_000;
const APPROVAL_COOLDOWN_MS = 60_000;
const APPROVAL_CACHE_SIZE = 256;

let approvalCooldownUntil = 0;
/** The same command in the same workspace gets the same answer; `npm test` is asked once. */
const approvalCache = new Map<string, ApprovalVerdict>();

export async function judgeApproval(call: ApprovalCall, signal?: AbortSignal): Promise<ApprovalVerdict | null> {
  const current = config();
  if (current.kind !== "jev" || !current.smartApproval) return null;
  if (Date.now() < approvalCooldownUntil) return null;

  const request = buildApprovalRequest(call);
  const key = canonicalize(request.state);
  const cached = approvalCache.get(key);
  if (cached) {
    approvalCache.delete(key);
    approvalCache.set(key, cached);
    return cached;
  }

  const backend = await backendFor(current);
  if (typeof backend === "string") return null;
  const stop = new AbortController();
  const release = trackDecisionWork(stop);
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const runtime = new DecisionRuntime({
    backend,
    trace: new DecisionTraceFile(getFastVibePaths().decisionTraceFile),
    requestTimeoutMs: APPROVAL_TIMEOUT_MS,
    maxRetries: 1,
    backoffMs: [200],
  });
  const started = Date.now();
  const run = runtime.startRun({ budgetKey: `approval:${started}`, deadlineAt: started + APPROVAL_TIMEOUT_MS + 500, maxRequests: 2, signal: stop.signal });
  try {
    const outcome = await run.decide(request, { policy: approvalPolicy });
    if (outcome.status === "handoff" && outcome.reason === "unreachable") {
      approvalCooldownUntil = Date.now() + APPROVAL_COOLDOWN_MS;
      log.warn(`[decision] approval judge unreachable, rules only for ${APPROVAL_COOLDOWN_MS / 1000}s: ${outcome.detail ?? ""}`);
    }
    const verdict = approvalVerdict(outcome);
    if (verdict) {
      approvalCache.set(key, verdict);
      if (approvalCache.size > APPROVAL_CACHE_SIZE) approvalCache.delete(approvalCache.keys().next().value as string);
    }
    return verdict;
  } catch (error) {
    // A malformed request is our bug, never a reason to skip a prompt: fall back to the rules.
    log.warn(`[decision] approval judge failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    run.finish();
    release();
    signal?.removeEventListener("abort", onAbort);
  }
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

/** Expose both scenarios to the extensions, which cannot import FastVibe internals. */
export function installDecisionScenarioGlobals(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__fastvibeBatchDecide = runBatchDecide;
  scope.__fastvibeBatchDecideEnabled = batchDecideEnabled;
  scope.__fastvibeApprovalJudge = judgeApproval;
  scope.__fastvibeApprovalJudgeEnabled = approvalJudgeEnabled;
}
