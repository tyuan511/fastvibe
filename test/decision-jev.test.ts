import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJevBody, createJevBackend, JEV_ENDPOINT, jevHttpError, normalizeJevResponse, testJevConnection } from "../src/main/engine/decision/backends/jev.ts";
import { adoptAnswers, thresholdPolicy } from "../src/main/engine/decision/dispatch.ts";
import type { DecideRequest } from "../src/main/engine/decision/protocol.ts";
import { DecisionBackendError } from "../src/main/engine/decision/runtime.ts";

/**
 * The Jev adapter is where our protocol meets somebody else's wire format
 * (docs/decision-layer.md §3.7). What must hold: host-only metadata never leaves,
 * every question carries the `instructions` Jev requires, the key only goes to the
 * fixed endpoint, and the response is renamed but not "fixed up".
 */

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
  const body = buildJevBody(request) as { model: string; questions: Record<string, Record<string, unknown>> };
  assert.equal(body.model, "jev-latest");
  assert.ok(!("binding" in body));
  assert.ok(!("requiredWhen" in body.questions.click_target));
  assert.equal(body.questions.operation.instructions, "Next step?");
  assert.equal(typeof body.questions.click_target.instructions, "string");
  assert.ok((body.questions.click_target.instructions as string).length > 0);
  assert.deepEqual(Object.keys(body.questions.relevant).sort(), ["instructions", "type"]);
});

test("the response is renamed into our shape and then validated by the protocol, not by the adapter", () => {
  const response = normalizeJevResponse({
    model: "jev-1.13.0",
    answers: {
      operation: { type: "choice", choice: "CLICK", probabilities: { CLICK: 0.93, DONE: 0.07 }, confidence: 0.9 },
      click_target: { type: "choice", choice: "e1", probabilities: { e1: 1 }, confidence: 1 },
      relevant: { type: "noul", noul: 0.8 },
    },
    usage: { input_tokens: 1500, output_tokens: 3 },
  });
  assert.equal(response.model, "jev-1.13.0");
  assert.deepEqual(response.usage, { inputTokens: 1500, outputTokens: 3 });
  assert.deepEqual((response.answers.operation as { confidence: unknown }).confidence, { value: 0.9, source: "reported" });
  const { outcome } = adoptAnswers(request.questions, response.answers, thresholdPolicy("t", 0.5));
  // noul has no reported confidence; 0.8 → binary-distance 0.6 ≥ 0.5.
  assert.equal(outcome.status, "decided");

  // An invented option passes the adapter untouched and is caught by validation.
  const bad = normalizeJevResponse({ answers: { operation: { type: "choice", choice: "HACK", confidence: 0.99 }, relevant: { type: "noul", noul: 1 } } });
  const judged = adoptAnswers(request.questions, bad.answers, thresholdPolicy("t", 0.5)).outcome;
  assert.equal(judged.status === "handoff" && judged.reason, "invalid_response");

  assert.throws(() => normalizeJevResponse({ nope: true }), DecisionBackendError);
});

test("HTTP statuses map to the documented error kinds and retryability", () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "auth", false],
    [422, "bad_request", false],
    [429, "rate_limit", true],
    [529, "overloaded", true],
    [503, "server", true],
    [302, "bad_request", false],
  ];
  for (const [status, kind, retryable] of cases) {
    const error = jevHttpError(status, "");
    assert.equal(error.kind, kind, `status ${status}`);
    assert.equal(error.retryable, retryable, `status ${status}`);
  }
});

test("the key goes only to the fixed endpoint and redirects are refused", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  const backend = createJevBackend({ apiKey: "sk-test", fetch: fakeFetch });
  await backend.decide(request, { signal: new AbortController().signal });
  assert.equal(seen[0].url, JEV_ENDPOINT);
  assert.equal(seen[0].init.redirect, "error");
  assert.equal((seen[0].init.headers as Record<string, string>).Authorization, "Bearer sk-test");
});

test("a non-2xx response throws a typed error that never echoes the key", async () => {
  const fakeFetch = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
  const backend = createJevBackend({ apiKey: "sk-secret", fetch: fakeFetch });
  await assert.rejects(backend.decide(request, { signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof DecisionBackendError);
    assert.equal(error.kind, "auth");
    assert.ok(!error.message.includes("sk-secret"));
    return true;
  });
});

test("test connection sends no state and reports auth failures distinctly", async () => {
  let body: unknown = "unset";
  const okFetch = (async (_url: string, init: RequestInit) => {
    body = init.body;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await testJevConnection("k", { fetch: okFetch }), { ok: true });
  assert.equal(body, undefined);
  const denied = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  const result = await testJevConnection("k", { fetch: denied });
  assert.equal(result.ok === false && result.kind, "auth");
});
