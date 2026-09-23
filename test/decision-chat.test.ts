import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatPrompt, createChatBackend, parseChatAnswers } from "../src/main/engine/decision/backends/chat.ts";
import { acceptValid, adoptAnswers } from "../src/main/engine/decision/dispatch.ts";
import type { DecideRequest } from "../src/main/engine/decision/protocol.ts";
import { DecisionBackendError } from "../src/main/engine/decision/runtime.ts";

/**
 * A large model is one more decision backend: same questions, same validation. What
 * must hold: the prompt carries each question's options and condition, replies are typed
 * per question, and anything the model invents is caught by the protocol, not trusted.
 */

const request: DecideRequest = {
  version: 1,
  binding: "browser.step",
  state: { page: { url: "https://example.test/" } },
  questions: {
    operation: { type: "choice", criteria: { CLICK: "click", DONE: "done" }, instructions: { goal: "open docs" } },
    click_target: { type: "choice", criteria: { "1": { element: "[1] Docs" } }, requiredWhen: { question: "operation", equals: "CLICK" } },
  },
};

test("the prompt carries options, instructions and the onlyIf condition", () => {
  const prompt = JSON.parse(buildChatPrompt(request));
  assert.deepEqual(prompt.questions.operation.options, { CLICK: "click", DONE: "done" });
  assert.deepEqual(prompt.questions.operation.instructions, { goal: "open docs" });
  assert.equal(prompt.questions.click_target.onlyIf, "operation == CLICK");
  assert.deepEqual(prompt.state, request.state);
});

test("replies are typed per question and judged by the protocol", async () => {
  const backend = createChatBackend({
    id: "llm:test",
    complete: async () => ({ text: '```json\n{"operation":"CLICK","click_target":"1"}\n```', model: "m", usage: { inputTokens: 10 } }),
  });
  const response = await backend.decide(request, { signal: new AbortController().signal });
  assert.equal(response.backend, "llm:test");
  assert.deepEqual(response.answers.operation, { type: "choice", choice: "CLICK" });
  const { outcome } = adoptAnswers(request.questions, response.answers, acceptValid("t"));
  assert.equal(outcome.status, "decided");

  const invented = parseChatAnswers('{"operation":"CLICK","click_target":"99"}', request.questions);
  assert.equal(adoptAnswers(request.questions, invented, acceptValid("t")).outcome.status, "handoff");
});

test("a reply that is not a JSON object is malformed", () => {
  assert.throws(() => parseChatAnswers("CLICK", request.questions), DecisionBackendError);
  assert.throws(() => parseChatAnswers('["CLICK"]', request.questions), DecisionBackendError);
});

test("the reply schema confines choices to legal keys; conditional heads may be null", async () => {
  let seen: Record<string, unknown> | undefined;
  const backend = createChatBackend({
    complete: async ({ schema }) => {
      seen = schema;
      return { text: '{"operation":"DONE","click_target":null}' };
    },
  });
  const response = await backend.decide(request, { signal: new AbortController().signal });
  const properties = (seen as { properties: Record<string, { enum: unknown[] }> }).properties;
  assert.deepEqual(properties.operation.enum, ["CLICK", "DONE"]);
  assert.deepEqual(properties.click_target.enum, ["1", null]);
  assert.deepEqual((seen as { required: string[] }).required, ["operation", "click_target"]);
  assert.equal("click_target" in response.answers, false, "null means not answered");
  assert.equal(adoptAnswers(request.questions, response.answers, acceptValid("t")).outcome.status, "decided");
});
