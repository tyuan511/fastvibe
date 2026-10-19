import assert from "node:assert/strict";
import test from "node:test";
import { canTurnThinkingOff, looksLikeRejectedParameter, withThinkingOff } from "../src/main/engine/thinking-off.ts";

test("only a reasoning model on an OpenAI-compatible API has a patch to try", () => {
  assert.equal(canTurnThinkingOff({ api: "openai-completions", reasoning: true }), true);
  assert.equal(canTurnThinkingOff({ api: "openai-completions", reasoning: false }), false);
  assert.equal(canTurnThinkingOff({ api: "anthropic-messages", reasoning: true }), false);
  assert.equal(canTurnThinkingOff({ api: "openai-responses", reasoning: true }), true, "a relay forwards the switches to its backend on /responses too");
  assert.equal(canTurnThinkingOff({ api: "google-generative-ai", reasoning: true }), false);
  assert.equal(canTurnThinkingOff({ reasoning: true }), false);
});

test("the patch adds all three switches and keeps the rest of the body", () => {
  const out = withThinkingOff({ model: "m", messages: [1], max_tokens: 50 }) as Record<string, any>;
  assert.equal(out.model, "m");
  assert.deepEqual(out.messages, [1]);
  assert.equal(out.max_tokens, 50);
  assert.equal(out.enable_thinking, false);
  assert.deepEqual(out.thinking, { type: "disabled" });
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false });
});

test("a switch the SDK already decided is not overridden, and kwargs are merged", () => {
  const out = withThinkingOff({ enable_thinking: true, thinking: { type: "enabled" }, chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }) as Record<string, any>;
  assert.equal(out.enable_thinking, true);
  assert.deepEqual(out.thinking, { type: "enabled" });
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
});

test("the input is not mutated and a non-object body passes through", () => {
  const body = { model: "m" };
  withThinkingOff(body);
  assert.deepEqual(body, { model: "m" });
  assert.equal(withThinkingOff(undefined), undefined);
  assert.deepEqual(withThinkingOff([1]), [1]);
});

test("only a refused parameter is worth retrying without the patch", () => {
  assert.equal(looksLikeRejectedParameter("400 Unrecognized request argument supplied: enable_thinking"), true);
  assert.equal(looksLikeRejectedParameter("Unknown parameter: 'chat_template_kwargs'."), true);
  assert.equal(looksLikeRejectedParameter("422 extra inputs are not permitted"), true);
  assert.equal(looksLikeRejectedParameter("429 rate limit exceeded"), false);
  assert.equal(looksLikeRejectedParameter("401 invalid api key"), false);
  assert.equal(looksLikeRejectedParameter("The operation timed out"), false);
  assert.equal(looksLikeRejectedParameter(undefined), false);
});

import { withThinkingOffFallback } from "../src/main/engine/thinking-off.ts";

const ok = { stopReason: "stop" };
const refusal = { stopReason: "error", errorMessage: "400 Unrecognized request argument: enable_thinking" };
const options = (refused = new Set<string>(), aborted = false) => ({ eligible: true, key: "p/m", refused, aborted: () => aborted });

test("a provider that takes the patch is asked once", async () => {
  const calls: boolean[] = [];
  const reply = await withThinkingOffFallback(async (patched) => (calls.push(patched), ok), options());
  assert.deepEqual(calls, [true]);
  assert.equal(reply, ok);
});

test("a refused patch is retried plain once and remembered, so the next request skips it", async () => {
  const refused = new Set<string>();
  const calls: boolean[] = [];
  const run = async (patched: boolean) => (calls.push(patched), patched ? refusal : ok);
  assert.equal(await withThinkingOffFallback(run, options(refused)), ok);
  assert.deepEqual(calls, [true, false]);
  assert.ok(refused.has("p/m"));
  calls.length = 0;
  await withThinkingOffFallback(run, options(refused));
  assert.deepEqual(calls, [false], "the second request goes straight to plain");
});

test("a refusal that is thrown rather than returned is handled the same way", async () => {
  const calls: boolean[] = [];
  const reply = await withThinkingOffFallback(async (patched) => {
    calls.push(patched);
    if (patched) throw new Error("422 extra inputs are not permitted");
    return ok;
  }, options());
  assert.deepEqual(calls, [true, false]);
  assert.equal(reply, ok);
});

test("other failures are not retried, and an ineligible model never gets the patch", async () => {
  const calls: boolean[] = [];
  await assert.rejects(withThinkingOffFallback(async (patched) => (calls.push(patched), { stopReason: "error", errorMessage: "429 rate limit" }), options()), /429/);
  assert.deepEqual(calls, [true]);
  const plain: boolean[] = [];
  await withThinkingOffFallback(async (patched) => (plain.push(patched), ok), { ...options(), eligible: false });
  assert.deepEqual(plain, [false]);
  const stopped: boolean[] = [];
  await assert.rejects(withThinkingOffFallback(async (patched) => (stopped.push(patched), refusal), options(new Set(), true)));
  assert.deepEqual(stopped, [true], "a stopped request is not asked again");
});

import { SUGGESTION_TOKENS, SUGGESTION_TOKENS_WITH_THINKING, suggestionMaxTokens } from "../src/main/engine/thinking-off.ts";

test("the small output cap is only for models that cannot think first", () => {
  assert.equal(suggestionMaxTokens({ api: "openai-completions", reasoning: false }), SUGGESTION_TOKENS, "not a reasoning model");
  assert.equal(suggestionMaxTokens({ api: "anthropic-messages", reasoning: true }), SUGGESTION_TOKENS, "no thinking is sent");
  // Whether a reasoning model thinks is not ours to decide, even with the thinking-off fields: room.
  assert.equal(suggestionMaxTokens({ api: "openai-completions", reasoning: true }), SUGGESTION_TOKENS_WITH_THINKING);
  assert.equal(suggestionMaxTokens({ api: "openai-responses", reasoning: true }), SUGGESTION_TOKENS_WITH_THINKING);
  assert.equal(suggestionMaxTokens({ api: "google-generative-ai", reasoning: true }), SUGGESTION_TOKENS_WITH_THINKING);
  assert.equal(suggestionMaxTokens({ api: "openai-completions", reasoning: true, maxTokens: 50 }), 50, "never above the model's own limit");
});
