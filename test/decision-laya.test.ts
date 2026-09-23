import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayaBody, createLayaBackend, LAYA_DEFAULT_BASE_URL, layaHttpError, normalizeLayaResponse, testLayaConnection } from "../src/main/engine/decision/backends/laya.ts";
import { adoptAnswers, thresholdPolicy } from "../src/main/engine/decision/dispatch.ts";
import type { DecideRequest } from "../src/main/engine/decision/protocol.ts";
import { DecisionBackendError } from "../src/main/engine/decision/runtime.ts";

const request: DecideRequest = {
  version: 1,
  binding: "browser.step",
  state: { url: "https://example.test/" },
  questions: {
    operation: { type: "choice", criteria: { CLICK: "click", DONE: "done" }, instructions: "Next step?" },
    click_target: { type: "choice", criteria: { e1: "Search" }, requiredWhen: { question: "operation", equals: "CLICK" } },
    relevant: { type: "noul" },
  },
};

test("the body drops host metadata and fills required instructions", () => {
  const body = buildLayaBody(request) as { state: unknown; questions: Record<string, Record<string, unknown>> };
  assert.ok(!("binding" in body));
  assert.deepEqual(body.state, { url: "https://example.test/" });
  assert.ok(!("requiredWhen" in body.questions.click_target));
  assert.equal(body.questions.operation.instructions, "Next step?");
  assert.ok((body.questions.click_target.instructions as string).length > 0);
  assert.deepEqual(Object.keys(body.questions.relevant).sort(), ["instructions", "type"]);
});

test("the response is renamed into our shape and then validated by the protocol, not by the adapter", () => {
  const response = normalizeLayaResponse({
    model: "laya-rl-agent",
    answers: {
      operation: { type: "choice", choice: "CLICK", probabilities: { CLICK: 0.93, DONE: 0.07 }, confidence: 0.9, action: { act_probability: 1 } },
      click_target: { type: "choice", choice: "e1", probabilities: { e1: 1 }, confidence: 1, action: { act_probability: 1 } },
      relevant: { type: "noul", noul: 0.8, confidence: 0.6, action: { act_probability: 1 } },
    },
    usage: { input_tokens: 349, output_tokens: 0 },
  });
  assert.equal(response.model, "laya-rl-agent");
  assert.deepEqual(response.usage, { inputTokens: 349, outputTokens: 0 });
  assert.deepEqual((response.answers.operation as { confidence: unknown }).confidence, { value: 0.9, source: "reported" });
  assert.equal("action" in (response.answers.operation as object), false);
  const { outcome } = adoptAnswers(request.questions, response.answers, thresholdPolicy("t", 0.5));
  assert.equal(outcome.status, "decided");

  const bad = normalizeLayaResponse({ answers: { operation: { type: "choice", choice: "HACK", confidence: 0.99 }, relevant: { type: "noul", noul: 1 } } });
  const judged = adoptAnswers(request.questions, bad.answers, thresholdPolicy("t", 0.5)).outcome;
  assert.equal(judged.status === "handoff" && judged.reason, "invalid_response");

  assert.throws(() => normalizeLayaResponse({ nope: true }), DecisionBackendError);
});

test("HTTP statuses map to error kinds and retryability", () => {
  const cases: Array<[number, string, boolean]> = [
    [400, "bad_request", false],
    [429, "rate_limit", true],
    [503, "server", true],
    [418, "bad_request", false],
  ];
  for (const [status, kind, retryable] of cases) {
    const error = layaHttpError(status, "");
    assert.equal(error.kind, kind, `status ${status}`);
    assert.equal(error.retryable, retryable, `status ${status}`);
  }
});

test("requests go to the configured base URL's /predict", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ model: "laya-rl-agent", answers: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  const backend = createLayaBackend({ baseUrl: "http://127.0.0.1:9999", fetch: fakeFetch });
  await backend.decide(request, { signal: new AbortController().signal });
  assert.equal(seen[0].url, "http://127.0.0.1:9999/predict");
  assert.equal((seen[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("a non-2xx response throws a typed error", async () => {
  const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const backend = createLayaBackend({ fetch: fakeFetch });
  await assert.rejects(backend.decide(request, { signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof DecisionBackendError);
    assert.equal(error.kind, "server");
    return true;
  });
});

test("test connection sends no state and reports its model", async () => {
  const okFetch = (async () => new Response(JSON.stringify({ status: "ok", model: "aac6fef/laya-mlx" }), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await testLayaConnection(LAYA_DEFAULT_BASE_URL, { fetch: okFetch }), { ok: true, model: "aac6fef/laya-mlx" });
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const result = await testLayaConnection(LAYA_DEFAULT_BASE_URL, { fetch: down });
  assert.equal(result.ok === false && result.kind, "network");
});

test("structured instructions and criteria reach Laya as readable text, goal first", () => {
  const body = buildLayaBody({
    version: 1,
    state: {},
    questions: {
      operation: { type: "choice", instructions: { goal: "填写表单", rules: "long rules" }, criteria: { CLICK: "click" } },
      click_target: { type: "choice", instructions: { goal: "填写表单" }, criteria: { "1": { element: "[1] 姓名", current_value: "", role: "textbox" } } },
    },
  }) as { questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
  assert.equal(body.questions.operation.instructions, "goal: 填写表单\nrules: long rules");
  assert.ok(!body.questions.operation.instructions.includes("\\u"), "no escaped non-ASCII");
  assert.equal(body.questions.click_target.criteria["1"], "element: [1] 姓名; role: textbox", "empty values dropped, one line");
});
