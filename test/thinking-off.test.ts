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

import {
  installThinkingOffGuard,
  looksLikeRejectedThinkingOff,
  modelWithoutThinkingOff,
  retryWithoutThinkingOff,
  roomForThinking,
  willSendThinkingOff,
  guardedModelFor,
  THINKING_ROOM_TOKENS,
} from "../src/main/engine/thinking-off.ts";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * A request that asks for no thinking is not a request that gets none: pi fills an OpenAI-family
 * `/responses` body with `reasoning: { effort: "none" }`, and the reasoning models before gpt-5.1
 * answer that with a 400. These pin both halves — what the SDK actually puts on the wire, and what
 * this app does when it is refused — because the payload rule is an SDK behaviour, not ours.
 */

const gpt5 = { id: "gpt-5", provider: "openai", api: "openai-responses", reasoning: true, maxTokens: 128_000 };
const offSwitchRefusal = { stopReason: "error", errorMessage: "Invalid value for 'reasoning.effort': 'none' is not supported by this model. Try using one of: minimal, low, medium, high" };

test("only a responses-family reasoning model is sent a thinking-off value nobody asked for", () => {
  assert.equal(willSendThinkingOff(gpt5), true);
  assert.equal(willSendThinkingOff({ ...gpt5, provider: "azure-openai", api: "azure-openai-responses" }), true);
  assert.equal(willSendThinkingOff({ ...gpt5, api: "openai-codex-responses" }), true);
  assert.equal(willSendThinkingOff({ ...gpt5, reasoning: false }), false, "not a reasoning model");
  assert.equal(willSendThinkingOff({ ...gpt5, api: "anthropic-messages" }), false);
  assert.equal(willSendThinkingOff({ ...gpt5, api: "google-generative-ai" }), false);
  // Chat completions sends reasoning_effort only where the model maps `off` itself, and FastVibe
  // never maps it — the exception is a model synced from pi's own catalog.
  assert.equal(willSendThinkingOff({ ...gpt5, api: "openai-completions" }), false);
  assert.equal(willSendThinkingOff({ ...gpt5, api: "openai-completions", thinkingLevelMap: { off: "none" } }), true);
  assert.equal(willSendThinkingOff({ ...gpt5, thinkingLevelMap: { off: null } }), false, "already told it has no off switch");
});

test("pi leaves the thinking parameter out when the model maps off to null", async () => {
  const sent = await bodies();
  await collect(responsesStream(sent.plain.model, context, sent.plain.options));
  await collect(responsesStream(sent.guarded.model, context, sent.guarded.options));
  assert.deepEqual(sent.captured.plain.reasoning, { effort: "none" }, "what a title request reaches today");
  assert.equal(sent.captured.guarded.reasoning, undefined, "and what it reaches once told there is no off switch");
});

test("a model that maps off to null is also spared on the completions wire", async () => {
  const sent = await bodies("openai-completions", { off: "none" });
  await collect(completionsStream(sent.plain.model, context, sent.plain.options));
  await collect(completionsStream(sent.guarded.model, context, sent.guarded.options));
  assert.equal(sent.captured.plain.reasoning_effort, "none");
  assert.equal(sent.captured.guarded.reasoning_effort, undefined);
});

const context = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi", }], timestamp: Date.now() }], tools: [] };

/** The bodies two requests put on the wire: the model as stored, and the same model guarded. */
async function bodies(api = "openai-responses", thinkingLevelMap?: Record<string, string | null>) {
  const model = { ...gpt5, api, baseUrl: "https://api.openai.com/v1", name: "GPT-5", contextWindow: 200_000, input: ["text"], headers: {}, compat: {}, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
  const captured: Record<string, any> = {};
  const fetchStub = (slot: string) => async (_url: string, init: { body?: string }) => {
    captured[slot] = JSON.parse(String(init.body));
    return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return {
    captured,
    plain: { model, options: { apiKey: "sk-probe", fetch: fetchStub("plain"), maxTokens: 128 } },
    guarded: { model: modelWithoutThinkingOff(model as never) as never, options: { apiKey: "sk-probe", fetch: fetchStub("guarded"), maxTokens: 128 } },
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _ of stream) void _;
  } catch {
    // The stub ends the stream with nothing to parse; only the captured body matters.
  }
}

test("taking the off switch away copies the model and keeps the rest of its map", () => {
  const model = { ...gpt5, thinkingLevelMap: { minimal: "minimal", high: null } };
  const guarded = modelWithoutThinkingOff(model);
  assert.notEqual(guarded, model);
  assert.deepEqual(model.thinkingLevelMap, { minimal: "minimal", high: null }, "the caller's model is untouched");
  assert.deepEqual(guarded.thinkingLevelMap, { minimal: "minimal", high: null, off: null });
  assert.equal(modelWithoutThinkingOff(guarded), guarded, "guarding twice is the same model");
});

test("the wording that means the thinking-off parameter itself was refused", () => {
  assert.equal(looksLikeRejectedThinkingOff(offSwitchRefusal.errorMessage), true);
  assert.equal(looksLikeRejectedThinkingOff('Invalid value: "none". Supported values are: "minimal", "low", "medium".'), true);
  assert.equal(looksLikeRejectedThinkingOff('400 {"error":{"message":"Unsupported parameter: reasoning.effort","param":"reasoning.effort"}}'), true);
  assert.equal(looksLikeRejectedThinkingOff("The value 'none' is invalid for property 'reasoning.effort'."), true);
  assert.equal(looksLikeRejectedThinkingOff("429 rate limit exceeded"), false);
  assert.equal(looksLikeRejectedThinkingOff("401 None of the provided API keys are valid"), false, "a quoted value, not the word none");
  assert.equal(looksLikeRejectedThinkingOff("The operation timed out"), false);
  assert.equal(looksLikeRejectedThinkingOff(undefined), false);
});

test("a request that can no longer be told not to think gets room to think", () => {
  assert.equal(roomForThinking({ maxTokens: 128_000 }, 128), THINKING_ROOM_TOKENS, "a title asked for one line");
  assert.equal(roomForThinking({ maxTokens: 600 }, 128), 600, "never above the model's own limit");
  assert.equal(roomForThinking({ maxTokens: 128_000 }, 16_000), 16_000, "an extraction already had the room");
  assert.equal(roomForThinking({}, undefined), THINKING_ROOM_TOKENS);
});

test("a refused thinking-off parameter is asked again without it, and the model is remembered", async () => {
  const refused = new Set<string>();
  const seen: Array<{ map?: Record<string, string | null>; maxTokens?: number }> = [];
  const run = async (model: typeof gpt5, options?: { maxTokens?: number }) => {
    seen.push({ map: model.thinkingLevelMap, maxTokens: options?.maxTokens });
    return seen.length === 1 ? offSwitchRefusal : { stopReason: "stop" };
  };
  const reply = await retryWithoutThinkingOff(run, { model: gpt5, options: { maxTokens: 128 }, refused });
  assert.equal(reply.stopReason, "stop");
  assert.deepEqual(seen, [{ map: undefined, maxTokens: 128 }, { map: { off: null }, maxTokens: THINKING_ROOM_TOKENS }]);
  assert.ok(refused.has("openai/gpt-5"));

  seen.length = 0;
  // The caller hands over the registry's own model again: the learning is in this helper, not in it.
  await retryWithoutThinkingOff(run, { model: gpt5, options: { maxTokens: 128 }, refused });
  assert.deepEqual(seen, [{ map: { off: null }, maxTokens: THINKING_ROOM_TOKENS }], "one request, already guarded");
});

test("every other failure is handed back exactly as it came", async () => {
  const refused = new Set<string>();
  const timeout = { stopReason: "error", errorMessage: "request timed out" };
  const seen: number[] = [];
  const reply = await retryWithoutThinkingOff(async () => (seen.push(1), timeout), { model: gpt5, options: { maxTokens: 128 }, refused });
  assert.equal(reply, timeout, "a returned failure stays a returned reply");
  assert.deepEqual(seen, [1]);
  assert.equal(refused.size, 0);

  await assert.rejects(
    retryWithoutThinkingOff(async () => { seen.push(2); throw new TypeError("runtime exploded"); }, { model: gpt5, refused }),
    TypeError,
    "a thrown error is not this helper's to swallow",
  );
  assert.equal(refused.size, 0);
});

test("a model with no invented off parameter is run untouched", async () => {
  const model = { ...gpt5, api: "anthropic-messages" };
  const options = { maxTokens: 128 };
  let seenModel: unknown, seenOptions: unknown;
  await retryWithoutThinkingOff(async (target, requestOptions) => ((seenModel = target), (seenOptions = requestOptions), { stopReason: "stop" }), {
    model,
    options,
    refused: new Set(),
  });
  assert.equal(seenModel, model, "not even copied");
  assert.equal(seenOptions, options, "and its options are its own");
});

test("the runtime guard reaches the request an extension makes", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const refused = new Set<string>();
  const runtime = {
    complete: async (model: Record<string, any>, _context: unknown, options?: Record<string, unknown>) => {
      seen.push({ off: model.thinkingLevelMap?.off, maxTokens: options?.maxTokens });
      return seen.length === 1 ? offSwitchRefusal : { stopReason: "stop" };
    },
    streamSimple: () => ({ push: () => {}, result: async () => ({ stopReason: "stop" }) }),
  };
  installThinkingOffGuard(runtime, refused);
  const reply = await runtime.complete(gpt5 as unknown as Record<string, any>, {}, { maxTokens: 128 });
  assert.equal(reply.stopReason, "stop");
  assert.deepEqual(seen, [{ off: undefined, maxTokens: 128 }, { off: null, maxTokens: THINKING_ROOM_TOKENS }]);
  assert.ok(refused.has("openai/gpt-5"));
});

test("the model runtime this guard wraps still answers to the two methods it wraps", () => {
  // `installThinkingOffGuard` reaches in by name, so an SDK rename has to fail here rather than
  // leave every request without a thinking level unguarded and silent. It binds both before
  // assigning anything, so a missing one cannot leave the runtime half-wrapped.
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>;
  assert.equal(typeof prototype.complete, "function");
  assert.equal(typeof prototype.streamSimple, "function");
});

test("pi 补值不区分「档位是 off」和「根本没表态」——所以主对话那条路也会中招", async () => {
  // `pi-agent-core` turns thinkingLevel "off" into `reasoning: undefined`, and `streamSimple`
  // answers that the same way it answers a caller that said nothing at all. This is why the guard
  // wraps `streamSimple` too: the agent's own requests and compaction go through it.
  const sent = await bodies("openai-responses");
  await collect(responsesStream(sent.plain.model, context, { ...sent.plain.options, reasoning: "off" }));
  assert.deepEqual(sent.captured.plain.reasoning, { effort: "none" });
});

test("一个已经学到没有开关的模型，交给 streamSimple 之前就被换掉了", () => {
  const refused = new Set<string>(["openai/gpt-5"]);
  const anthropic = { ...gpt5, api: "anthropic-messages" };
  const guarded = guardedModelFor(gpt5, refused);
  assert.equal(guarded.thinkingLevelMap?.off, null);
  assert.notEqual(guarded, gpt5, "registry 里那份模型对象不能被改");
  assert.equal(guardedModelFor(guarded, refused), guarded, "已经保护过的不再复制");
  assert.equal(guardedModelFor(gpt5, new Set()), gpt5, "没学到之前什么也不做");
  assert.equal(guardedModelFor(anthropic, refused), anthropic, "pi 不会替它补值的模型不碰");
});

test("streamSimple 的包装只换模型，不动那条流本身", async () => {
  const seen: Array<Record<string, any>> = [];
  const stream = { push: () => {}, result: async () => ({ stopReason: "stop" }) };
  const runtime: any = {
    complete: async () => ({ stopReason: "stop" }),
    streamSimple: (model: Record<string, any>) => {
      seen.push(model);
      return stream;
    },
  };
  const refused = new Set<string>(["openai/gpt-5"]);
  installThinkingOffGuard(runtime, refused);
  const returned = runtime.streamSimple(gpt5 as never, {}, { maxTokens: 128 } as never);
  assert.equal(returned, stream, "返回的还是 SDK 那条 AssistantMessageEventStream");
  assert.equal(seen[0].thinkingLevelMap?.off, null);
});
