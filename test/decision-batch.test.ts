import { test } from "node:test";
import assert from "node:assert/strict";
import { batchPolicy, BATCH_LIMITS, itemResult, prepareBatch, runBatch, summarizeBatch, type BatchInput } from "../src/main/engine/decision/batch.ts";
import { adoptAnswers } from "../src/main/engine/decision/dispatch.ts";
import { assertValidQuestions, type DecideRequest, type DecisionOutcome } from "../src/main/engine/decision/protocol.ts";

/**
 * `batch_decide` (docs/decision-layer.md §7.10). The shape is where its scope is enforced,
 * so the refusals are tested as carefully as the happy path: a batch too small, an open
 * question, or an option with no meaning never reaches the decision model.
 */

function items(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `i${index}`, content: { title: `issue ${index}` } }));
}

const base: BatchInput = {
  instructions: "Triage each GitHub issue.",
  questions: {
    kind: { type: "choice", options: { bug: "Something is broken", feature: "A request for new behaviour", other: "Neither" } },
    urgent: { type: "yes_no", instructions: "Does it block users today?" },
    effort: { type: "score", levels: ["trivial", "small", "large"] },
  },
  items: items(6),
};

test("a well-formed batch becomes one valid request per item", () => {
  const prepared = prepareBatch({ ...base, context: "A CLI tool" });
  assert.ok(prepared.ok);
  assertValidQuestions(prepared.batch.questions);
  assert.equal(prepared.batch.items.length, 6);
  assert.deepEqual(prepared.batch.items[0].state, { item: { title: "issue 0" }, context: "A CLI tool" });
  const urgent = prepared.batch.questions.urgent;
  assert.equal(urgent.type, "noul");
  assert.match(String(urgent.instructions), /Triage each GitHub issue\.\n\nDoes it block users today\?/);
  assert.equal(prepared.batch.minConfidence, 0.7);
});

test("too few items are refused so the agent judges them itself", () => {
  const prepared = prepareBatch({ ...base, items: items(BATCH_LIMITS.minItems - 1) });
  assert.equal(prepared.ok, false);
});

test("too many items are refused", () => {
  assert.equal(prepareBatch({ ...base, items: items(BATCH_LIMITS.maxItems + 1) }).ok, false);
});

test("a choice needs two options, each with a meaning", () => {
  assert.equal(prepareBatch({ ...base, questions: { kind: { type: "choice", options: { bug: "Broken" } } } }).ok, false);
  assert.equal(prepareBatch({ ...base, questions: { kind: { type: "choice", options: { bug: "Broken", feature: " " } } } }).ok, false);
});

test("an unknown question type is refused — there is no free-text answer", () => {
  assert.equal(prepareBatch({ ...base, questions: { summary: { type: "text" as never } } }).ok, false);
});

test("a score needs 2–10 levels", () => {
  assert.equal(prepareBatch({ ...base, questions: { effort: { type: "score", levels: ["only"] } } }).ok, false);
});

test("duplicate or empty item ids are refused", () => {
  assert.equal(prepareBatch({ ...base, items: [...items(5), { id: "i0", content: "again" }] }).ok, false);
  assert.equal(prepareBatch({ ...base, items: [...items(5), { id: " ", content: "x" }] }).ok, false);
});

test("empty instructions are refused", () => {
  assert.equal(prepareBatch({ ...base, instructions: "  " }).ok, false);
});

test("an oversized item fails alone without a request", async () => {
  const big = { id: "big", content: "x".repeat(BATCH_LIMITS.maxItemChars + 10) };
  const prepared = prepareBatch({ ...base, items: [...items(5), big] });
  assert.ok(prepared.ok);
  const sent: string[] = [];
  const results = await runBatch(prepared.batch, async (request) => {
    sent.push(JSON.stringify(request.state));
    return decided();
  });
  assert.equal(sent.length, 5);
  assert.equal(results[5].status, "failed");
  assert.match(results[5].reason ?? "", /oversized/);
});

function decided(): DecisionOutcome {
  return {
    status: "decided",
    activeQuestionIds: ["kind"],
    answers: { kind: { type: "choice", choice: "bug", confidence: { value: 0.93, source: "reported" } } },
  };
}

test("results keep the agent's order under concurrency", async () => {
  const prepared = prepareBatch({ ...base, items: items(20) });
  assert.ok(prepared.ok);
  const results = await runBatch(
    prepared.batch,
    async (request: DecideRequest) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      assert.ok(request.state);
      return decided();
    },
    { concurrency: 4 },
  );
  assert.deepEqual(results.map((result) => result.id), prepared.batch.items.map((item) => item.id));
  assert.deepEqual(summarizeBatch(results), { total: 20, decided: 20, review: 0, failed: 0 });
});

test("below the floor an item comes back as review with its best guess", () => {
  const prepared = prepareBatch(base);
  assert.ok(prepared.ok);
  const { outcome } = adoptAnswers(
    prepared.batch.questions,
    {
      kind: { type: "choice", choice: "bug", confidence: { value: 0.55, source: "reported" } },
      urgent: { type: "noul", noul: 0.95 },
      effort: { type: "score", score: 1.2 },
    },
    batchPolicy(prepared.batch.minConfidence),
  );
  const result = itemResult("i0", outcome);
  assert.equal(result.status, "review");
  assert.deepEqual(result.answers?.kind, { choice: "bug", confidence: 0.55 });
  // A score without a reported confidence is taken as given, not sent to review.
  assert.doesNotMatch(result.reason ?? "", /effort/);
});

test("a decided item carries compact answers", () => {
  const prepared = prepareBatch(base);
  assert.ok(prepared.ok);
  const { outcome } = adoptAnswers(
    prepared.batch.questions,
    {
      kind: { type: "choice", choice: "feature", confidence: { value: 0.9, source: "reported" } },
      urgent: { type: "noul", noul: 0.1 },
      effort: { type: "score", score: 2, confidence: { value: 0.8, source: "reported" } },
    },
    batchPolicy(prepared.batch.minConfidence),
  );
  assert.deepEqual(itemResult("i1", outcome), {
    id: "i1",
    status: "decided",
    answers: {
      kind: { choice: "feature", confidence: 0.9 },
      urgent: { yes: false, p: 0.1, confidence: 0.8 },
      effort: { score: 2, confidence: 0.8 },
    },
  });
});

test("an unreachable backend fails the item with its reason", () => {
  assert.deepEqual(itemResult("i2", { status: "handoff", reason: "unreachable", detail: "network: down" }), {
    id: "i2",
    status: "failed",
    reason: "unreachable: network: down",
  });
});
