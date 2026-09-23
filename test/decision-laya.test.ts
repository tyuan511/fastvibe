import assert from "node:assert/strict";
import test from "node:test";
import { decideWithLaya, LayaBackendError } from "../src/main/engine/decision/backends/laya.ts";
import type { DecideRequest } from "../src/main/engine/decision/protocol.ts";

/**
 * The adapter's whole job is normalizing laya-mlx's Python-shaped JSON into
 * docs/decision-layer.md's protocol, and stripping host-only metadata on the way out — both
 * silent-failure modes if wrong (a caller reading `answer.confidence.value` on a bare float
 * throws nowhere useful; a leaked `requiredWhen` just quietly reaches the model's request log).
 */

const TRIAGE_QUESTIONS: DecideRequest["questions"] = {
  intent: { type: "choice", instructions: "what now", criteria: { refund: "money back", other: "anything else" } },
  is_urgent: { type: "noul", instructions: "urgent?" },
  frustration: { type: "score", instructions: "how mad", criteria: ["calm", "annoyed", "furious"] },
};

function stub(handler: (body: unknown) => { status?: number; body?: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), body: parsed });
    const route = handler(parsed);
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function request(overrides: Partial<DecideRequest> = {}): DecideRequest {
  return { version: 1, state: { body: "refund me" }, questions: TRIAGE_QUESTIONS, ...overrides };
}

test("sends state and questions to /predict, with requiredWhen stripped", async () => {
  const { impl, calls } = stub(() => ({
    body: {
      model: "laya-rl-agent",
      answers: {
        intent: { type: "choice", choice: "refund", confidence: 0.9, probabilities: { refund: 0.9, other: 0.1 }, action: { act_probability: 1 } },
        is_urgent: { type: "noul", noul: 0.4, confidence: 0.6, action: { act_probability: 1 } },
        frustration: { type: "score", score: 1.2, confidence: 0.3, action: { act_probability: 1 } },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  }));

  const req = request({
    questions: {
      ...TRIAGE_QUESTIONS,
      intent: { ...TRIAGE_QUESTIONS.intent, requiredWhen: { question: "is_urgent", equals: "true" } } as DecideRequest["questions"]["intent"],
    },
  });

  await decideWithLaya(req, { baseUrl: "http://x" }, undefined, impl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://x/predict");
  const sent = calls[0].body as { state: unknown; questions: Record<string, unknown> };
  assert.deepEqual(sent.state, { body: "refund me" });
  assert.equal("requiredWhen" in (sent.questions.intent as object), false);
});

test("normalizes choice/noul/score answers, confidence, and usage", async () => {
  const { impl } = stub(() => ({
    body: {
      model: "laya-rl-agent",
      answers: {
        intent: { type: "choice", choice: "refund", confidence: 0.9, probabilities: { refund: 0.9, other: 0.1 }, action: { act_probability: 1 } },
        is_urgent: { type: "noul", noul: 0.4, confidence: 0.6, action: { act_probability: 1 } },
        frustration: { type: "score", score: 1.2, confidence: 0.3, action: { act_probability: 1 } },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  }));

  const result = await decideWithLaya(request(), {}, undefined, impl);

  assert.equal(result.version, 1);
  assert.equal(result.backend, "laya");
  assert.deepEqual(result.answers.intent, {
    type: "choice",
    choice: "refund",
    probabilities: { refund: 0.9, other: 0.1 },
    confidence: { value: 0.9, source: "reported" },
  });
  assert.deepEqual(result.answers.is_urgent, { type: "noul", noul: 0.4, confidence: { value: 0.6, source: "reported" } });
  assert.equal(result.answers.frustration.type, "score");
  assert.equal((result.answers.frustration as { score: number }).score, 1.2);
  // laya's own `action` head has no place in the protocol — must not survive normalization.
  assert.equal("action" in result.answers.intent, false);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 0 });
});

test("a choice outside its own criteria is rejected, not passed through", async () => {
  const { impl } = stub(() => ({
    body: { answers: { intent: { type: "choice", choice: "made_up_option" }, is_urgent: { type: "noul", noul: 0.1 }, frustration: { type: "score", score: 1 } } },
  }));
  await assert.rejects(() => decideWithLaya(request(), {}, undefined, impl), LayaBackendError);
});

test("a missing answer for a requested question is rejected rather than defaulted", async () => {
  const { impl } = stub(() => ({ body: { answers: { intent: { type: "choice", choice: "refund" } } } }));
  await assert.rejects(() => decideWithLaya(request(), {}, undefined, impl), LayaBackendError);
});

test("an HTTP error status is surfaced as LayaBackendError, not a malformed response", async () => {
  const impl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(() => decideWithLaya(request(), {}, undefined, impl), LayaBackendError);
});

test("a network failure is wrapped, not left as a raw fetch rejection", async () => {
  const impl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  await assert.rejects(() => decideWithLaya(request(), {}, undefined, impl), LayaBackendError);
});

test("an unsupported protocol version is rejected before any network call", async () => {
  const { impl, calls } = stub(() => ({ body: {} }));
  await assert.rejects(
    () => decideWithLaya({ ...request(), version: 2 as 1 }, {}, undefined, impl),
    LayaBackendError,
  );
  assert.equal(calls.length, 0);
});

test("a missing confidence is dropped, never defaulted to 0 or 1", async () => {
  const { impl } = stub(() => ({
    body: { answers: { intent: { type: "choice", choice: "refund" }, is_urgent: { type: "noul", noul: 0.1 }, frustration: { type: "score", score: 1 } } },
  }));
  const result = await decideWithLaya(request(), {}, undefined, impl);
  assert.equal(result.answers.intent.confidence, undefined);
});
