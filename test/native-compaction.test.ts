import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  convertToLlm, estimateTokens, serializeConversation, shouldCompact, type SessionBeforeCompactEvent, type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { compactWithinWindow, installNativeCompactionGuard } from "../src/main/engine/native-compaction.ts";
import { isCompactionCancelled } from "../src/shared/abort.ts";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
function preparation(text: string, previousSummary?: string): CompactionPreparation {
  return {
    firstKeptEntryId: "kept", tokensBefore: 200_000,
    messagesToSummarize: [{ role: "user", content: text, timestamp: 1 }],
    turnPrefixMessages: [], isSplitTurn: false, previousSummary,
    fileOps: { read: new Set(["a.ts"]), edited: new Set(["b.ts"]), written: new Set() },
    settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 4096 },
  };
}
const textOf = (p: CompactionPreparation) => serializeConversation(convertToLlm(p.messagesToSummarize));
const reply = (p: CompactionPreparation, n = 1): CompactionResult => ({
  summary: `checkpoint ${n}`, firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore,
  details: { readFiles: [...p.fileOps.read], modifiedFiles: [...p.fileOps.edited, ...p.fileOps.written] },
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("fitting histories keep the native path and user focus unchanged", async () => {
  const p = preparation("small task");
  let calls = 0;
  const result = await compactWithinWindow(p, { contextWindow: 128_000, maxTokens: 8192 }, async (input, focus) => {
    calls++;
    assert.equal(input, p);
    assert.equal(focus, "retain the migration decision");
    return reply(input);
  }, undefined, "retain the migration decision");
  assert.equal(calls, 1);
  assert.equal(result.summary, "checkpoint 1");
});

test("oversized Chinese history and an old large summary are sliced BEFORE any request", async () => {
  const p = preparation(`FIRST${"中文😀".repeat(24_000)}LAST`, "OLD " + "old constraint ".repeat(4000));
  const original = structuredClone(p);
  const sent: string[] = [];
  const result = await compactWithinWindow(p, { contextWindow: 16_384, maxTokens: 2048 }, async (part) => {
    assert.notEqual(part, p, "the original oversized preparation is never sent");
    const text = (part.messagesToSummarize[0] as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(Buffer.byteLength(text + (part.previousSummary ?? "")) / 3 + 2048 + 4096 <= 16_384);
    assert.ok(!text.includes("�"));
    if (sent.length) assert.equal(part.previousSummary, `checkpoint ${sent.length}`);
    sent.push(text);
    return reply(part, sent.length);
  });
  assert.ok(sent.length > 1);
  assert.equal(sent.join(""), `<previous-summary>\n${p.previousSummary}\n</previous-summary>\n\n${textOf(p)}`);
  assert.deepEqual(p, original, "raw history and file operations are never mutated");
  assert.equal(result.firstKeptEntryId, "kept");
  assert.deepEqual(result.details, { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
  assert.equal(result.usage?.input, sent.length, "all intermediate summaries count toward usage");
});

test("a smaller real provider limit shrinks the rejected input on each retry", async () => {
  const rejected: number[] = [];
  let accepted = 0;
  const p = preparation("x".repeat(30_000));
  await compactWithinWindow(p, { contextWindow: 128_000, maxTokens: 4096 }, async (part) => {
    const bytes = Buffer.byteLength(textOf(part) + (part.previousSummary ?? ""));
    if (bytes > 12_000) {
      rejected.push(bytes);
      throw new Error("prompt is too long: input exceeds the context window");
    }
    accepted++;
    return reply(part, accepted);
  });
  assert.ok(rejected.length >= 2);
  assert.ok(rejected.every((size, index) => index === 0 || size < rejected[index - 1]));
  assert.ok(accepted > 0);
});

test("permanent errors and user cancellation do not become slicing retries", async () => {
  let calls = 0;
  await assert.rejects(compactWithinWindow(preparation("small"), { contextWindow: 16_384, maxTokens: 2048 }, async () => {
    calls++;
    throw new Error("401 invalid API key");
  }), /401/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(compactWithinWindow(preparation("x".repeat(100_000)), { contextWindow: 16_384, maxTokens: 2048 }, async (part) => {
    calls++;
    controller.abort(new Error("user stopped"));
    return reply(part);
  }, controller.signal), /user stopped/);
  assert.equal(calls, 1);
});

test("an incomplete summary caused by a clamped output budget retries with less input", async () => {
  const sizes: number[] = [];
  await compactWithinWindow(preparation("x".repeat(20_000)), { contextWindow: 32_768, maxTokens: 4096 }, async (part) => {
    sizes.push(Buffer.byteLength(textOf(part) + (part.previousSummary ?? "")));
    if (sizes.length === 1) throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
    return reply(part, sizes.length);
  });
  assert.ok(sizes.length > 1);
  assert.ok(sizes[1] < sizes[0]);
});

test("an endpoint rejecting every size cannot cause an unbounded compaction loop", async () => {
  let calls = 0;
  await assert.rejects(compactWithinWindow(preparation("x".repeat(400_000)), { contextWindow: 32_768, maxTokens: 4096 }, async () => {
    calls++;
    throw new Error("context_length_exceeded");
  }), /context_length_exceeded/);
  assert.ok(calls <= 7);
});

async function harness(auto: boolean, options: {
  largeWindow?: number; largeMaxTokens?: number; lastUsage?: number;
  systemPrompt?: string;
  summaryReply?: () => ReturnType<typeof fauxAssistantMessage>;
  taskReply?: () => ReturnType<typeof fauxAssistantMessage>;
  continueAfterError?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-compaction-"));
  const models = [
    { id: "large", name: "large", contextWindow: options.largeWindow ?? 200_000, maxTokens: options.largeMaxTokens ?? 4096 },
    { id: "small", name: "small", contextWindow: 16_384, maxTokens: 2048 },
    { id: "roomy", name: "roomy", contextWindow: 200_000, maxTokens: 4096 },
  ].map((model) => ({ ...model, reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const faux = createFauxCore({ api: "faux-compaction", provider: "faux", models, tokenSize: { min: 1024, max: 1024 } });
  const requests: Array<{ model: string; summary: boolean; tokens: number; maxOutput: number; fits: boolean }> = [];
  const respond: FauxResponseFactory = (context, request, _state, model) => {
    const summary = JSON.stringify(context.messages).includes("You are a context summarization assistant");
    const tokens = context.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    const fits = tokens + (request?.maxTokens ?? model.maxTokens) <= model.contextWindow;
    requests.push({ model: model.id, summary, tokens, maxOutput: request?.maxTokens ?? model.maxTokens, fits });
    if (summary && options.summaryReply) return options.summaryReply();
    if (!summary && options.taskReply) return options.taskReply();
    return fits ? fauxAssistantMessage(summary ? "## Goal\nContinue the user's task.\n## Progress\nEarlier work summarized.\n## Next Steps\nContinue from the retained messages." : "continued successfully")
      : fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
  };
  faux.setResponses(Array.from({ length: 100 }, () => respond));
  const runtime = await ModelRuntime.create({ credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { api: "faux-compaction", baseUrl: "http://faux.invalid", apiKey: "unused", streamSimple: faux.streamSimple, models });
  const sm = SessionManager.inMemory();
  if (options.systemPrompt) sm.appendMessage({ role: "system", content: options.systemPrompt, timestamp: 0 });
  for (let i = 0; i < 30; i++) {
    sm.appendMessage({ role: "user", content: `task ${i}: ${"x".repeat(5000)}`, timestamp: i * 2 + 1 });
    const message = { ...fauxAssistantMessage(`done ${i}`), provider: "faux", model: "large", timestamp: i * 2 + 2 };
    if (i === 29 && options.lastUsage !== undefined) message.usage = { ...message.usage, input: options.lastUsage, totalTokens: options.lastUsage };
    sm.appendMessage(message);
  }
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: auto }, retry: { enabled: false } });
  let continuations = 0;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager, noExtensions: true, noSkills: true, systemPrompt: options.systemPrompt,
    extensionFactories: options.continueAfterError ? [{
      name: "test-continue-after-error",
      factory: (pi) => { pi.on("agent_before_settle", (event) => {
        if (event.outcome !== "error" || ++continuations > 3) return;
        return { continue: true, entries: [{ type: "custom_message", customType: "continue-test", content: "Continue the task", display: false }] };
      }); },
    }] : [],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime: runtime, model: runtime.getModel("faux", "large"), sessionManager: sm, settingsManager, resourceLoader: loader, tools: [] });
  installNativeCompactionGuard(session);
  await session.bindExtensions({ mode: "rpc" });
  const errors: unknown[] = [];
  let starts = 0;
  session.subscribe((event) => {
    if (event.type === "compaction_start") starts++;
    if (event.type === "compaction_end" && !event.result) errors.push(event);
  });
  return { session, sm, settingsManager, runtime, requests, errors, starts: () => starts, continuations: () => continuations, close: () => { session.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const auto of [false, true]) {
  test(`${auto ? "automatic" : "manual"} native compaction after a large-to-small model switch fits before sending and resumes`, { timeout: 10_000 }, async () => {
    const h = await harness(auto);
    try {
      assert.equal(h.settingsManager.getCompactionKeepRecentTokens(h.session.model), 20_000);
      const oldMessages = h.sm.getBranch().filter((entry) => entry.type === "message");
      await h.session.setModel(h.runtime.getModel("faux", "small")!);
      assert.equal(h.settingsManager.getCompactionKeepRecentTokens(h.session.model), 4096);
      assert.equal(h.settingsManager.getCompactionReserveTokens(h.session.model), 1639);
      if (!auto) await h.session.compact();
      await h.session.prompt("Continue the current task.");
      const compactions = h.sm.getBranch().filter((entry) => entry.type === "compaction");
      assert.equal(compactions.length, 1);
      assert.equal(compactions[0].fromHook, false, "the summary and checkpoint remain Pi-native");
      assert.ok(h.requests.filter((request) => request.summary).length > 1, "oversized history is handled in slices");
      assert.ok(h.requests.every((request) => request.model === "small" && request.fits));
      assert.equal(h.requests.at(-1)?.summary, false, "the actual task resumes after compaction");
      assert.deepEqual(h.errors, []);
      assert.deepEqual(h.sm.getBranch().filter((entry) => entry.type === "message").slice(0, oldMessages.length), oldMessages);
      assert.equal(h.session.isIdle, true);
      await h.session.setModel(h.runtime.getModel("faux", "large")!);
      assert.equal(h.settingsManager.getCompactionKeepRecentTokens(h.session.model), 20_000);
      assert.equal(h.settingsManager.getCompactionReserveTokens(h.session.model), 20_000);
    } finally { h.close(); }
  });
}

test("the real SDK threshold is 90% at every supported window and follows metadata changes", async () => {
  const h = await harness(true);
  try {
    const model = h.session.model!;
    for (const [window, limit] of [[16_384, 14_745], [128_000, 115_200], [200_000, 180_000], [272_000, 244_800], [1_000_000, 900_000]]) {
      const selected = { ...model, contextWindow: window };
      const settings = h.settingsManager.getCompactionSettings(selected);
      assert.equal(window - settings.reserveTokens, limit);
      assert.equal(shouldCompact(limit, window, settings), false);
      assert.equal(shouldCompact(limit + 1, window, settings), true);
    }
    for (const contextWindow of [0, -1, NaN, Infinity]) {
      assert.equal(h.settingsManager.getCompactionReserveTokens({ ...model, contextWindow }), 16_384);
    }
    h.session.setAutoCompactionEnabled(false);
    assert.equal(shouldCompact(950_000, 1_000_000, h.settingsManager.getCompactionSettings({ ...model, contextWindow: 1_000_000 })), false);
  } finally { h.close(); }
});

for (const used of [890_000, 900_001]) {
  test(`without switching models, a 1M session at ${used} tokens ${used > 900_000 ? "compacts" : "does not compact"}`, { timeout: 10_000 }, async () => {
    const h = await harness(true, { largeWindow: 1_000_000, largeMaxTokens: 128_000, lastUsage: used });
    try {
      await h.session.prompt("Continue with the same model.");
      const summaries = h.requests.filter((request) => request.summary);
      const entries = h.sm.getBranch().filter((entry) => entry.type === "compaction");
      assert.equal(entries.length, used > 900_000 ? 1 : 0);
      if (used > 900_000) {
        assert.ok(summaries.length > 0);
        assert.ok(summaries.every((request) => request.maxOutput <= Math.floor(16_384 * 0.8)), "the 100K trigger reserve must not become the summary output budget");
        assert.equal(entries[0].fromHook, false);
      } else assert.equal(summaries.length, 0);
      assert.ok(h.requests.every((request) => request.model === "large" && request.fits));
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("persistent size rejection stops one run and is not retried by subsequent automatic runs", { timeout: 10_000 }, async () => {
  let fail = true;
  const h = await harness(true, {
    largeWindow: 1_000_000, lastUsage: 900_001, continueAfterError: true,
    summaryReply: () => fail ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "context_length_exceeded" }) : fauxAssistantMessage("Task checkpoint."),
  });
  try {
    await h.session.prompt("Continue").catch(() => undefined);
    const attempts = h.requests.length;
    assert.ok(attempts > 0 && attempts <= 7);
    assert.equal(h.starts(), 1);
    assert.equal(h.errors.length, 1);
    assert.ok(h.requests.every((request) => request.summary), "the oversized normal request is not sent after summary failure");
    assert.equal(h.session.isIdle, true);
    for (let i = 0; i < 3; i++) await h.session.prompt("Continue").catch(() => undefined);
    assert.equal(h.requests.length, attempts, "new prompts and error rows do not restart the same failed compaction");
    assert.equal(h.starts(), 1);
    assert.equal(h.errors.length, 1);
    assert.equal(h.session.isIdle, true);
    assert.equal(h.continuations(), 0, "an automatic continuation extension never gets to restart the failed run");
    fail = false;
    await h.session.compact(); // explicit retry is permitted even on the same model/history
    await h.session.prompt("Continue after manual recovery");
    assert.equal(h.requests.at(-1)?.summary, false);
    assert.equal(h.session.isIdle, true);
  } finally { h.close(); }
});

test("a non-shrinking automatic summary is rejected before it becomes a checkpoint", { timeout: 10_000 }, async () => {
  const h = await harness(true, { largeWindow: 1_000_000, lastUsage: 900_001, summaryReply: () => fauxAssistantMessage("x".repeat(170_000)) });
  try {
    await h.session.prompt("Continue").catch(() => undefined);
    assert.equal(h.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.equal(h.errors.length, 1);
    assert.match(JSON.stringify(h.errors), /did not reduce/);
    const count = h.requests.length;
    await h.session.prompt("Try to continue automatically").catch(() => undefined);
    assert.equal(h.requests.length, count);
    assert.equal(h.starts(), 1);
    assert.equal(h.session.isIdle, true);
  } finally { h.close(); }
});

test("a system prompt that cannot fit stops the cycle, and increasing the model window releases it", { timeout: 10_000 }, async () => {
  const h = await harness(true, { largeWindow: 16_384, systemPrompt: "Fixed system instructions. ".repeat(4000) });
  try {
    await h.session.prompt("Continue").catch(() => undefined);
    assert.equal(h.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.equal(h.errors.length, 1);
    assert.match(JSON.stringify(h.errors), /budget/);
    const count = h.requests.length;
    await h.session.prompt("Continue again").catch(() => undefined);
    assert.equal(h.requests.length, count);
    await h.session.setModel(h.runtime.getModel("faux", "roomy")!);
    await h.session.prompt("Continue with the larger window");
    assert.ok(h.requests.slice(count).some((request) => !request.summary && request.model === "roomy" && request.fits));
    assert.equal(h.errors.length, 1, "only the original small-window failure is reported");
    assert.equal(h.session.isIdle, true);
  } finally { h.close(); }
});

test("an ordinary request still rejected after recovery cannot restart the compaction cycle", { timeout: 10_000 }, async () => {
  const h = await harness(true, {
    largeWindow: 1_000_000, lastUsage: 900_001,
    taskReply: () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long", timestamp: Date.now() + 10_000 }),
  });
  try {
    const stopped = await h.session.prompt("Continue").then(() => undefined, (error: unknown) => error);
    assert.ok(h.requests.filter((request) => !request.summary).length <= 2);
    assert.ok(h.errors.length > 0 || stopped instanceof Error);
    const count = h.requests.length;
    const starts = h.starts();
    await h.session.prompt("Continue again").catch(() => undefined);
    assert.equal(h.requests.length, count);
    assert.equal(h.starts(), starts);
    assert.equal(h.session.isIdle, true);
  } finally { h.close(); }
});

test("editing the failed history releases the block without a manual compaction", { timeout: 10_000 }, async () => {
  const h = await harness(true, {
    largeWindow: 1_000_000, lastUsage: 900_001,
    summaryReply: () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "context_length_exceeded" }),
  });
  try {
    await h.session.prompt("Continue").catch(() => undefined);
    const calls = h.requests.length;
    const user = h.sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
    h.sm.appendContextEdit(user.id, { content: "A shorter corrected request." });
    await h.session.prompt("Continue with the edited history");
    assert.ok(h.requests.length > calls);
    assert.equal(h.requests.at(-1)?.summary, false);
    assert.equal(h.session.isIdle, true);
  } finally { h.close(); }
});

test("cancelling an explicit retry preserves the previous capacity block", { timeout: 10_000 }, async () => {
  let cancel = false;
  const h = await harness(true, {
    largeWindow: 1_000_000, lastUsage: 900_001,
    summaryReply: () => {
      if (cancel) h.session.abortCompaction();
      return fauxAssistantMessage("", { stopReason: cancel ? "aborted" : "error", errorMessage: "context_length_exceeded" });
    },
  });
  try {
    await h.session.prompt("Continue").catch(() => undefined);
    cancel = true;
    await assert.rejects(h.session.compact(), isCompactionCancelled);
    const count = h.requests.length;
    await h.session.prompt("Continue after cancellation").catch(() => undefined);
    assert.equal(h.requests.length, count);
    assert.equal(h.session.isIdle, true);
  } finally { h.close(); }
});
