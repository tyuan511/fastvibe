import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thresholdPolicy } from "../src/main/engine/decision/dispatch.ts";
import type { DecideRequest, DecideResponse } from "../src/main/engine/decision/protocol.ts";
import { DecisionBackendError, DecisionRuntime, type DecisionBackend } from "../src/main/engine/decision/runtime.ts";
import { DecisionTraceFile, type DecisionTraceRecord } from "../src/main/engine/decision/trace.ts";

/**
 * The runtime's promises are about what does *not* happen: no request after a cancel,
 * no retry of an auth failure, no second backend after a timeout, no page text in the
 * trace. A scripted fake backend makes each of those observable.
 */

const policy = thresholdPolicy("test/v1", 0.8);

const request: DecideRequest = {
  version: 1,
  binding: "browser.step",
  state: { url: "https://example.test/", text: "SECRET PAGE TEXT" },
  questions: {
    operation: { type: "choice", criteria: { CLICK: "click the target", DONE: "the goal is met" } },
    click_target: { type: "choice", criteria: { e1: "Search button", NONE: "none" }, requiredWhen: { question: "operation", equals: "CLICK" } },
  },
};

const good: DecideResponse = {
  version: 1,
  backend: "fake",
  model: "fake-1.0.0",
  answers: {
    operation: { type: "choice", choice: "CLICK", confidence: { value: 0.95, source: "reported" } },
    click_target: { type: "choice", choice: "e1", confidence: { value: 0.9, source: "reported" } },
  },
  usage: { inputTokens: 120, outputTokens: 2 },
};

type Step = DecideResponse | DecisionBackendError | "hang";

/** Plays `steps` in order, one per call; `hang` never resolves until aborted. */
function scripted(steps: Step[]): DecisionBackend & { calls: number } {
  const backend = {
    id: "fake",
    calls: 0,
    decide(_request: DecideRequest, { signal }: { signal: AbortSignal }): Promise<DecideResponse> {
      const step = steps[Math.min(backend.calls, steps.length - 1)];
      backend.calls++;
      if (step === "hang") {
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      if (step instanceof DecisionBackendError) return Promise.reject(step);
      return Promise.resolve(step);
    },
  };
  return backend;
}

function memoryTrace(): { append(record: DecisionTraceRecord): void; records: DecisionTraceRecord[] } {
  const records: DecisionTraceRecord[] = [];
  return { records, append: (record) => records.push(record) };
}

const soon = (ms = 60_000) => Date.now() + ms;

test("a clean decision is decided and traced without page text", async () => {
  const trace = memoryTrace();
  const runtime = new DecisionRuntime({ backend: scripted([good]), trace });
  const run = runtime.startRun({ budgetKey: "browser-run:1", deadlineAt: soon() });
  const outcome = await run.decide(request, { policy });
  assert.equal(outcome.status, "decided");
  assert.equal(trace.records.length, 1);
  const [record] = trace.records;
  assert.equal(record.outcome, "decided");
  assert.equal(record.model, "fake-1.0.0");
  assert.equal(record.policyVersion, "test/v1");
  assert.deepEqual(record.questions.click_target, { type: "choice", options: 2, conditional: true });
  assert.equal(record.answerSummary.operation.choice, "CLICK");
  assert.match(record.stateHash, /^sha256:[0-9a-f]{64}$/);
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("SECRET PAGE TEXT"), "state text must not be traced");
  assert.ok(!serialized.includes("Search button"), "criteria descriptions must not be traced");
});

test("retryable failures are retried within the request window, then succeed", async () => {
  const backend = scripted([new DecisionBackendError("rate_limit", "429", { status: 429 }), new DecisionBackendError("overloaded", "529", { status: 529 }), good]);
  const trace = memoryTrace();
  const runtime = new DecisionRuntime({ backend, trace, backoffMs: [1] });
  const run = runtime.startRun({ budgetKey: "k", deadlineAt: soon() });
  assert.equal((await run.decide(request, { policy })).status, "decided");
  assert.equal(backend.calls, 3);
  assert.equal(run.requestsUsed, 3, "every attempt counts against the run budget");
  assert.deepEqual(trace.records[0].errors, ["rate_limit:429", "overloaded:529"]);
});

test("auth and bad requests are not retried", async () => {
  for (const error of [new DecisionBackendError("auth", "401", { status: 401 }), new DecisionBackendError("bad_request", "422", { status: 422 })]) {
    const backend = scripted([error, good]);
    const runtime = new DecisionRuntime({ backend, backoffMs: [1] });
    const outcome = await runtime.startRun({ budgetKey: "k", deadlineAt: soon() }).decide(request, { policy });
    assert.equal(outcome.status === "handoff" && outcome.reason, "unreachable");
    assert.equal(backend.calls, 1);
  }
});

test("retries stop after maxRetries and hand off as unreachable", async () => {
  const backend = scripted([new DecisionBackendError("server", "500", { status: 500 })]);
  const runtime = new DecisionRuntime({ backend, backoffMs: [1], maxRetries: 2 });
  const outcome = await runtime.startRun({ budgetKey: "k", deadlineAt: soon() }).decide(request, { policy });
  assert.equal(outcome.status === "handoff" && outcome.reason, "unreachable");
  assert.equal(backend.calls, 3);
});

test("a request timeout inside a longer run is unreachable, not exhausted", async () => {
  const backend = scripted(["hang"]);
  const runtime = new DecisionRuntime({ backend, requestTimeoutMs: 30, backoffMs: [1] });
  const run = runtime.startRun({ budgetKey: "k", deadlineAt: soon() });
  const outcome = await run.decide(request, { policy });
  assert.equal(outcome.status === "handoff" && outcome.reason, "unreachable");
  assert.ok(run.remainingMs() > 0, "the run itself still has time for a takeover");
});

test("hitting the run deadline is exhausted, and the next call does not reach the backend", async () => {
  const backend = scripted(["hang"]);
  const runtime = new DecisionRuntime({ backend, requestTimeoutMs: 5_000 });
  const run = runtime.startRun({ budgetKey: "k", deadlineAt: Date.now() + 30 });
  assert.deepEqual(await run.decide(request, { policy }), { status: "exhausted", reason: "deadline" });
  const calls = backend.calls;
  assert.deepEqual(await run.decide(request, { policy }), { status: "exhausted", reason: "deadline" });
  assert.equal(backend.calls, calls);
});

test("the request budget is shared across phases and exhausts the run", async () => {
  const backend = scripted([good]);
  const runtime = new DecisionRuntime({ backend });
  const run = runtime.startRun({ budgetKey: "k", deadlineAt: soon(), maxRequests: 2 });
  assert.deepEqual(run.reserve(), { ok: true }, "e.g. a text-resolution request");
  assert.equal((await run.decide(request, { policy })).status, "decided");
  assert.deepEqual(await run.decide(request, { policy }), { status: "exhausted", reason: "budget" });
  assert.equal(backend.calls, 1);
});

test("cancelling mid-request yields cancelled and no further requests, not a handoff", async () => {
  const backend = scripted(["hang", good]);
  const runtime = new DecisionRuntime({ backend });
  const stop = new AbortController();
  const run = runtime.startRun({ budgetKey: "k", deadlineAt: soon(), signal: stop.signal });
  const pending = run.decide(request, { policy });
  setTimeout(() => stop.abort(), 10);
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.deepEqual(await run.decide(request, { policy }), { status: "cancelled" });
  assert.equal(backend.calls, 1);
});

test("revokeAll stops every active run", async () => {
  const backend = scripted(["hang"]);
  const runtime = new DecisionRuntime({ backend });
  const a = runtime.startRun({ budgetKey: "a", deadlineAt: soon() });
  const b = runtime.startRun({ budgetKey: "b", deadlineAt: soon() });
  const pending = a.decide(request, { policy });
  setTimeout(() => runtime.revokeAll(), 10);
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.deepEqual(await b.decide(request, { policy }), { status: "cancelled" });
  assert.equal(runtime.activeRuns, 0);
});

test("an oversized request is screened without calling the backend", async () => {
  const backend = scripted([good]);
  const trace = memoryTrace();
  const runtime = new DecisionRuntime({ backend, trace, sizeLimits: { maxRequestTokens: 10, maxStateTokens: 10 } });
  const outcome = await runtime.startRun({ budgetKey: "k", deadlineAt: soon() }).decide(request, { policy });
  assert.equal(outcome.status === "handoff" && outcome.reason, "oversized");
  assert.equal(backend.calls, 0);
  assert.equal(trace.records[0].attempts, 0);
});

test("a malformed question set throws instead of spending a request", async () => {
  const backend = scripted([good]);
  const run = new DecisionRuntime({ backend }).startRun({ budgetKey: "k", deadlineAt: soon() });
  await assert.rejects(run.decide({ ...request, questions: {} }, { policy }), /at least one question/);
  assert.equal(backend.calls, 0);
  assert.equal(run.requestsUsed, 0);
});

test("the trace file is append-only, 0600, and trimmed to the newest records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-decision-trace-"));
  try {
    const file = join(dir, "decision-trace.jsonl");
    const sink = new DecisionTraceFile(file, 4);
    const runtime = new DecisionRuntime({ backend: scripted([good]), trace: sink });
    const run = runtime.startRun({ budgetKey: "k", deadlineAt: soon() });
    for (let i = 0; i < 7; i++) await run.decide(request, { policy });
    const records = sink.read();
    assert.ok(records.length <= 6 && records.length >= 4, `kept ${records.length}`);
    assert.equal(((await stat(file)).mode & 0o777).toString(8), "600");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run started with an aborted signal is cancelled and never counted active", async () => {
  const backend = scripted([good]);
  const runtime = new DecisionRuntime({ backend });
  const stop = new AbortController();
  stop.abort();
  const run = runtime.startRun({ budgetKey: "k", deadlineAt: soon(), signal: stop.signal });
  assert.equal(runtime.activeRuns, 0);
  assert.deepEqual(await run.decide(request, { policy }), { status: "cancelled" });
  assert.equal(backend.calls, 0);
});
