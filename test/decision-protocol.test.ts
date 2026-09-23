import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValidQuestions,
  canonicalize,
  checkAnswer,
  DecisionRequestError,
  effectiveConfidence,
  type Question,
} from "../src/main/engine/decision/protocol.ts";
import { adoptAnswers, screenRequest, thresholdPolicy } from "../src/main/engine/decision/dispatch.ts";

/**
 * The decision protocol's job is to stop a consumer from acting on an answer it should
 * not act on. Every failure here is silent in production — the browser just clicks the
 * wrong thing — so each rule in docs/decision-layer.md §3.3/§3.6 gets a test.
 */

const policy = thresholdPolicy("test/v1", 0.8);

/** operation + one speculative target per operation, as browser.step builds them. */
const browserQuestions: Record<string, Question> = {
  operation: { type: "choice", criteria: { CLICK: "click", TYPE_TEXT: "type", DONE: "done" } },
  click_target: { type: "choice", criteria: { e1: "Search", e2: "Login", NONE: "none" }, requiredWhen: { question: "operation", equals: "CLICK" } },
  type_text_target: { type: "choice", criteria: { e3: "query box", NONE: "none" }, requiredWhen: { question: "operation", equals: "TYPE_TEXT" } },
};

const sure = (choice: string, value = 0.95) => ({ type: "choice", choice, confidence: { value, source: "reported" } });

test("canonicalize sorts keys, keeps array order and rejects non-JSON", () => {
  assert.equal(canonicalize({ b: 1, a: [3, { d: 1, c: 2 }] }), '{"a":[3,{"c":2,"d":1}],"b":1}');
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.throws(() => canonicalize({ a: undefined }), DecisionRequestError);
  assert.throws(() => canonicalize({ a: Number.NaN }), DecisionRequestError);
  assert.throws(() => canonicalize({ a: () => 1 }), DecisionRequestError);
  assert.throws(() => canonicalize(new Date()), DecisionRequestError);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalize(cycle), DecisionRequestError);
  // A repeated (non-circular) reference is fine.
  const shared = { x: 1 };
  assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

test("question sets the caller built wrongly throw before any request", () => {
  assert.doesNotThrow(() => assertValidQuestions(browserQuestions));
  assert.throws(() => assertValidQuestions({}), DecisionRequestError);
  assert.throws(() => assertValidQuestions({ op: { type: "choice", criteria: {} } }), /at least one option/);
  const many: Record<string, string> = {};
  for (let i = 0; i < 256; i++) many[`o${i}`] = "x";
  assert.throws(() => assertValidQuestions({ op: { type: "choice", criteria: many } }), /exceeds 255/);
  assert.throws(() => assertValidQuestions({ s: { type: "score", criteria: ["only"] } }), /2–10 levels/);
  assert.throws(() => assertValidQuestions({ s: { type: "score", criteria: ["a", "b"], min: 2, max: 1 } }), /min < max/);
  // requiredWhen: unknown question, unknown option, non-choice head, chained head, self.
  const op = browserQuestions.operation;
  assert.throws(() => assertValidQuestions({ t: { type: "noul", requiredWhen: { question: "x", equals: "A" } } }), /unknown question/);
  assert.throws(() => assertValidQuestions({ op, t: { type: "noul", requiredWhen: { question: "op", equals: "NOPE" } } }), /unknown option/);
  assert.throws(
    () => assertValidQuestions({ n: { type: "noul" }, t: { type: "noul", requiredWhen: { question: "n", equals: "true" } } }),
    /must name a choice/,
  );
  assert.throws(
    () =>
      assertValidQuestions({
        op,
        mid: { type: "choice", criteria: { A: "a" }, requiredWhen: { question: "op", equals: "CLICK" } },
        t: { type: "noul", requiredWhen: { question: "mid", equals: "A" } },
      }),
    /unconditional/,
  );
  assert.throws(() => assertValidQuestions({ t: { type: "choice", criteria: { A: "a" }, requiredWhen: { question: "t", equals: "A" } } }), /unknown question/);
});

test("a choice outside the criteria is rejected, never clamped", () => {
  const q = browserQuestions.operation;
  assert.equal(checkAnswer(q, sure("CLICK")).ok, true);
  const invented = checkAnswer(q, sure("SCROLL"));
  assert.equal(invented.ok, false);
  assert.equal(checkAnswer(q, { type: "score", score: 1 }).ok, false);
  assert.equal(checkAnswer(q, null).ok, false);
});

test("probabilities must match the criteria, sum to 1 and agree with the choice", () => {
  const q = browserQuestions.operation;
  const good = { type: "choice", choice: "CLICK", probabilities: { CLICK: 0.7, TYPE_TEXT: 0.2, DONE: 0.1 } };
  assert.equal(checkAnswer(q, good).ok, true);
  assert.equal(checkAnswer(q, { ...good, probabilities: { CLICK: 0.8, TYPE_TEXT: 0.2 } }).ok, false, "missing key");
  assert.equal(checkAnswer(q, { ...good, probabilities: { CLICK: 0.7, TYPE_TEXT: 0.2, DONE: 0.1, X: 0 } }).ok, false, "extra key");
  assert.equal(checkAnswer(q, { ...good, probabilities: { CLICK: 0.5, TYPE_TEXT: 0.2, DONE: 0.1 } }).ok, false, "sum 0.8");
  assert.equal(checkAnswer(q, { ...good, probabilities: { CLICK: 0.7, TYPE_TEXT: 0.4, DONE: -0.1 } }).ok, false, "negative");
  assert.equal(checkAnswer(q, { ...good, choice: "DONE" }).ok, false, "choice is not the argmax");
  assert.equal(checkAnswer(q, { ...good, probabilities: { CLICK: 0.7, TYPE_TEXT: 0.2, DONE: 0.11 } }).ok, true, "within 2% tolerance");
});

test("score and noul stay inside their declared ranges", () => {
  const score: Question = { type: "score", criteria: ["low", "mid", "high"] };
  assert.equal(checkAnswer(score, { type: "score", score: 1.4 }).ok, true);
  assert.equal(checkAnswer(score, { type: "score", score: 2.01 }).ok, false);
  assert.equal(checkAnswer(score, { type: "score", score: -0.1 }).ok, false);
  const noul: Question = { type: "noul" };
  assert.equal(checkAnswer(noul, { type: "noul", noul: 0.3 }).ok, true);
  assert.equal(checkAnswer(noul, { type: "noul", noul: 1.2 }).ok, false);
  assert.equal(checkAnswer(noul, { type: "noul", noul: 0.3, confidence: { value: 2, source: "reported" } }).ok, false);
  assert.equal(checkAnswer(noul, { type: "noul", noul: 0.3, confidence: { value: 0.5, source: "estimated" } }).ok, false, "estimated needs a method");
});

test("confidence: reported wins, choice and noul are estimated with the method named, missing stays missing", () => {
  assert.deepEqual(effectiveConfidence({ type: "choice", choice: "A", confidence: { value: 0.9, source: "reported" } }), { value: 0.9, source: "reported" });
  const estimated = effectiveConfidence({ type: "choice", choice: "A", probabilities: { A: 0.6, B: 0.3, C: 0.1 } });
  assert.equal(estimated?.source, "estimated");
  assert.ok(estimated && Math.abs(estimated.value - 0.3) < 1e-9);
  assert.deepEqual(effectiveConfidence({ type: "noul", noul: 0.9 }), { value: 0.8, source: "estimated", method: "binary-distance" });
  assert.equal(effectiveConfidence({ type: "choice", choice: "A" }), undefined);
  assert.equal(effectiveConfidence({ type: "score", score: 1, probabilities: { "0": 0.5, "1": 0.5 } }), undefined);
});

test("a confident CLICK with a confident target is decided, and only the active heads are returned", () => {
  const { outcome } = adoptAnswers(
    browserQuestions,
    { operation: sure("CLICK"), click_target: sure("e2"), type_text_target: sure("e3", 0.1) },
    policy,
  );
  assert.equal(outcome.status, "decided");
  if (outcome.status !== "decided") return;
  assert.deepEqual(outcome.activeQuestionIds, ["operation", "click_target"]);
  assert.deepEqual(Object.keys(outcome.answers), ["operation", "click_target"]);
});

test("an unselected head that is missing, malformed or unsure does not escalate", () => {
  for (const typeHead of [undefined, { type: "choice", choice: "e99" }, sure("e3", 0.1)]) {
    const answers: Record<string, unknown> = { operation: sure("CLICK"), click_target: sure("e1") };
    if (typeHead) answers.type_text_target = typeHead;
    assert.equal(adoptAnswers(browserQuestions, answers, policy).outcome.status, "decided");
  }
});

test("the selected head missing or invalid is invalid_response; unsure is unsure", () => {
  const missing = adoptAnswers(browserQuestions, { operation: sure("CLICK") }, policy).outcome;
  assert.equal(missing.status === "handoff" && missing.reason, "invalid_response");
  assert.deepEqual(missing.status === "handoff" && missing.affectedQuestionIds, ["click_target"]);

  const invented = adoptAnswers(browserQuestions, { operation: sure("CLICK"), click_target: sure("e9") }, policy).outcome;
  assert.equal(invented.status === "handoff" && invented.reason, "invalid_response");

  const unsure = adoptAnswers(browserQuestions, { operation: sure("CLICK"), click_target: sure("e1", 0.5) }, policy).outcome;
  assert.equal(unsure.status === "handoff" && unsure.reason, "unsure");
  assert.deepEqual(unsure.status === "handoff" && unsure.affectedQuestionIds, ["click_target"]);
  // The partial answers explain the handoff; they include the operation, never as a command.
  assert.ok(unsure.status === "handoff" && unsure.partialAnswers?.operation);
});

test("an unsure operation hands off before any target is looked at", () => {
  const { outcome } = adoptAnswers(browserQuestions, { operation: sure("CLICK", 0.4), click_target: { type: "choice", choice: "bogus" } }, policy);
  assert.equal(outcome.status === "handoff" && outcome.reason, "unsure");
  assert.deepEqual(outcome.status === "handoff" && outcome.affectedQuestionIds, ["operation"]);
});

test("an answer without any confidence signal is not adopted", () => {
  const { outcome } = adoptAnswers(browserQuestions, { operation: { type: "choice", choice: "DONE" } }, policy);
  assert.equal(outcome.status === "handoff" && outcome.reason, "unsure");
});

test("an answer for a question nobody asked is invalid_response", () => {
  const { outcome } = adoptAnswers(browserQuestions, { operation: sure("DONE"), surprise: sure("x") }, policy);
  assert.equal(outcome.status === "handoff" && outcome.reason, "invalid_response");
});

test("oversized requests hand off before a request is made", () => {
  const request = { version: 1 as const, state: { text: "x".repeat(10_000) }, questions: { op: browserQuestions.operation } };
  assert.equal(screenRequest(request, { maxRequestTokens: 64_000, maxStateTokens: 32_000 }), null);
  const tight = screenRequest(request, { maxRequestTokens: 64_000, maxStateTokens: 4_000 });
  assert.equal(tight?.reason, "oversized");
  // CJK text is counted by bytes, so it is not under-estimated the way chars/4 would.
  const cjk = { version: 1 as const, state: { text: "页".repeat(3_000) }, questions: { op: browserQuestions.operation } };
  assert.equal(screenRequest(cjk, { maxRequestTokens: 64_000, maxStateTokens: 4_000 })?.reason, "oversized");
});
