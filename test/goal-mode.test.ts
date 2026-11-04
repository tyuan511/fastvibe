import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { GOAL_ENTRY, goalResult, goalTokens, newGoal, restoreGoal, type Goal } from "../resources/extensions/goal/state.ts";
import { executionUnavailable, GoalClock } from "../resources/extensions/goal/progress.ts";
import { GoalDescendantUsage } from "../src/main/engine/goal-descendant-usage.ts";

const usage = { input: 1, output: 1, cacheRead: 50, cacheWrite: 0, totalTokens: 52, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text: string, stopReason = "stop") => ({
  role: "assistant" as const, content: [{ type: "text", text }] as unknown[], provider: "fake", model: "m", api: "openai-completions", timestamp: Date.now(), stopReason, usage,
  ...(stopReason === "error" ? { errorMessage: "429 Too Many Requests" } : {}),
});
const update = (status: string) => ({ ...assistant("", "toolUse"), content: [{ type: "toolCall", id: `goal-${status}-${Math.random()}`, name: "update_goal", arguments: { status } }] });
const call = (name: string, args: object = {}) => ({ ...assistant("", "toolUse"), content: [{ type: "toolCall", id: `${name}-${Math.random()}`, name, arguments: args }] });
const shellFixture = (outcomes: Array<"unavailable" | "exit" | "success">): ((pi: ExtensionAPI) => void) => (pi) => {
  pi.registerTool({ name: "bash", label: "Test shell", description: "Execution outcome fixture", parameters: { type: "object", properties: {} } as never,
    async execute() {
      const outcome = outcomes.shift();
      if (outcome === "unavailable") throw new Error("spawn /missing-shell ENOENT");
      if (outcome === "exit") return { content: [{ type: "text", text: "Command exited with code 1" }], details: {}, structuredContent: { exit_code: 1 }, isError: true };
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  });
};
type Reply = ReturnType<typeof assistant>;

/** Real SDK: provider context, execution of the goal tools, retries and pre-settle admission. */
async function harness(script: Reply[], options: { retries?: number; entries?: object[]; extensions?: Array<(pi: ExtensionAPI) => void>; goalAccounting?: () => unknown; onRequest?: (call: number, signal?: AbortSignal) => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-goal-"));
  let calls = 0;
  const contexts: Array<{ messages: unknown[] }> = [];
  const streamFn = (_model: unknown, context: { messages: unknown[] }, streamOptions?: { signal?: AbortSignal }) => {
    contexts.push(structuredClone(context));
    if (calls >= script.length) throw new Error(`Unexpected request ${calls + 1}`);
    let partial = script[calls++];
    const call = calls;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial };
        await options.onRequest?.(call, streamOptions?.signal);
        if (streamOptions?.signal?.aborted) partial = assistant("", "aborted");
        if (partial.stopReason === "error" || partial.stopReason === "aborted") yield { type: "error", reason: partial.stopReason, error: partial };
        else yield { type: "done", reason: partial.stopReason, message: partial };
      },
      result: async () => partial,
    };
  };
  const runtime = await ModelRuntime.create({ credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("fake", { baseUrl: "http://fake.invalid", api: "openai-completions", apiKey: "unused", streamSimple: streamFn as never,
    models: [{ id: "m", name: "F", contextWindow: 100_000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: (options.retries ?? 0) > 0, maxRetries: options.retries ?? 0, baseDelayMs: 1 } });
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  for (const data of options.entries ?? []) sessionManager.appendCustomEntry(GOAL_ENTRY, data);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager, additionalExtensionPaths: [new URL("../resources/extensions/goal.ts", import.meta.url).pathname], extensionFactories: options.extensions });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ sessionManager, settingsManager, cwd: dir, agentDir: join(dir, "agent"), resourceLoader, modelRuntime: runtime, model: runtime.getModel("fake", "m") });
  const statuses: Array<Goal | null> = [];
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "rpc", uiContext: {
    goalAccounting: options.goalAccounting,
    setStatus: (key: string, text?: string) => { if (key === "goal") statuses.push(text ? JSON.parse(text) : null); },
    notify: () => undefined, select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
    onTerminalInput: () => () => undefined, setWidget: () => undefined, setTitle: () => undefined, setEditorText: () => undefined, getEditorText: () => "", setFooter: () => undefined, setHeader: () => undefined,
  } as never, commandContextActions: { waitForIdle: () => session.waitForIdle() } as never, onError: (error: unknown) => errors.push(error) });
  return {
    session, sessionManager, contexts, statuses, errors, calls: () => calls,
    current: () => restoreGoal(sessionManager.getEntries()),
    prompt: async (text: string) => { await session.prompt(text); await session.waitForIdle(); },
    close: async () => { await session.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function withGoal(script: Reply[], check: (h: Awaited<ReturnType<typeof harness>>) => Promise<void> | void, options: Parameters<typeof harness>[1] = {}) {
  const h = await harness(script, options);
  try { await h.prompt("/goal 一个很大的任务"); await check(h); assert.deepEqual(h.errors, []); }
  finally { await h.close(); }
}

test("goal uses structured completion and hidden continuations with no fabricated user prompts", async () => {
  await withGoal([assistant("第 1 轮"), assistant("引用 GOAL_COMPLETE 仍不是完成"), update("complete"), assistant("已验证全部完成")], (h) => {
    assert.equal(h.calls(), 4);
    assert.equal(h.current()?.status, "complete");
    assert.equal(h.current()?.tokensUsed, 6); // Three requests before update_goal; cache reads excluded.
    const users = h.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user");
    assert.equal(users.length, 1);
    assert.ok(JSON.stringify(h.session.messages).includes("引用 GOAL_COMPLETE 仍不是完成"));
    for (const context of h.contexts.slice(0, 3)) {
      const snapshots = context.messages.filter((m) => JSON.stringify(m).includes("Completion audit"));
      assert.equal(snapshots.length, 1);
      assert.match(JSON.stringify(snapshots), /Completion audit/);
    }
    assert.doesNotMatch(JSON.stringify(h.contexts.at(-1)), /Completion audit/);
  });
});

test("terminal request errors block while a successful SDK retry preserves the goal", async () => {
  await withGoal([assistant("进展"), assistant("", "error")], (h) => {
    assert.equal(h.calls(), 2); assert.equal(h.current()?.status, "blocked");
  });
  await withGoal([assistant("", "error"), assistant("恢复"), update("complete"), assistant("完成")], (h) => {
    assert.equal(h.calls(), 4); assert.equal(h.current()?.status, "complete");
    assert.equal(h.statuses.some((g) => g?.status === "blocked"), false);
  }, { retries: 1 });
});

test("Stop pauses the goal and never admits another automatic turn", async () => {
  await withGoal([assistant("半句话", "aborted")], (h) => { assert.equal(h.calls(), 1); assert.equal(h.current()?.status, "paused"); });
});

test("three empty rounds block; productive work is not capped at 100 rounds", async () => {
  await withGoal([assistant(""), assistant(" "), assistant(""), assistant("")], (h) => { assert.equal(h.calls(), 4); assert.equal(h.current()?.status, "blocked"); });
  await withGoal([...Array.from({ length: 103 }, () => assistant("确有进展")), update("complete"), assistant("完成")], (h) => {
    assert.equal(h.calls(), 105); assert.equal(h.current()?.status, "complete");
  });
});

test("clear is durable across reload and navigating to history before clear", async () => {
  const goal = { ...newGoal("恢复测试"), status: "paused" };
  const h = await harness([], { entries: [goal] });
  try {
    const before = h.sessionManager.getLeafId();
    assert.equal(h.current()?.objective, "恢复测试");
    await h.prompt("/goal clear");
    assert.equal(h.current(), null);
    await h.session.reload();
    assert.equal(h.statuses.at(-1), null);
    h.sessionManager.branch(before!);
    await h.session.reload();
    assert.equal(h.statuses.at(-1), null);
  } finally { await h.close(); }
});

test("token budget excludes cache reads and stops continuations; explicit increase then resume works", async () => {
  const h = await harness([assistant("预算耗尽"), update("complete"), assistant("完成")], { entries: [{ ...newGoal("预算目标", 2), status: "paused" }] });
  try {
    await h.prompt("/goal resume");
    assert.equal(h.calls(), 1); assert.equal(h.current()?.status, "budget_limited"); assert.equal(h.current()?.tokensUsed, 2);
    await h.prompt("/goal resume"); assert.equal(h.calls(), 1);
    await h.prompt("/goal budget 100"); assert.equal(h.current()?.status, "paused");
    await h.prompt("/goal resume"); assert.equal(h.current()?.status, "complete"); assert.equal(h.calls(), 3);
  } finally { await h.close(); }
});

test("model cannot replace an unfinished goal; blocked audit is an explicit model contract", async () => {
  const create = { ...assistant("", "toolUse"), content: [{ type: "toolCall", id: "create", name: "create_goal", arguments: { objective: "偷换目标" } }] };
  await withGoal([create, update("blocked"), assistant("同一阻塞需要用户介入")], (h) => {
    assert.equal(h.current()?.objective, "一个很大的任务");
    assert.equal(h.current()?.status, "blocked");
    const results = h.session.messages.filter((m) => m.role === "toolResult");
    assert.ok(results.some((m) => m.role === "toolResult" && m.isError && /unfinished|未完成/.test(JSON.stringify(m))));
    assert.match(JSON.stringify(h.contexts[0]), /at least three consecutive goal turns/);
  });
});

test("legacy records, clear tombstones, strict budgets and uncached accounting", () => {
  const legacy = { type: "custom", customType: GOAL_ENTRY, data: { objective: "旧目标", status: "running", round: 42 } };
  assert.equal(restoreGoal([legacy])?.status, "paused");
  assert.equal(restoreGoal([legacy, { type: "custom", customType: GOAL_ENTRY, data: null }]), null);
  assert.equal(goalTokens({ input: 7, output: 3, cacheRead: 100, cacheWrite: 2 }), 12);
  assert.throws(() => newGoal("x", 0)); assert.throws(() => newGoal("x", Infinity)); assert.throws(() => newGoal(" "));
});


test("armed mode uses the next real prompt; ordinary tasks never create goals", async () => {
  const h = await harness([assistant("普通回答"), update("complete"), assistant("完成")]);
  try {
    await h.prompt("普通任务"); assert.equal(h.current(), null); assert.equal(h.calls(), 1);
    await h.prompt("/goal"); assert.equal(h.calls(), 1);
    await h.prompt("这是完整目标"); assert.equal(h.current()?.objective, "这是完整目标"); assert.equal(h.current()?.status, "complete");
  } finally { await h.close(); }
});

test("model create/get tools use the same persistent state and require explicit completion", async () => {
  const tool = (name: string, args: object) => ({ ...assistant("", "toolUse"), content: [{ type: "toolCall", id: name, name, arguments: args }] });
  const h = await harness([tool("create_goal", { objective: "用户明确要求的目标", token_budget: 1000 }), tool("get_goal", {}), update("complete"), assistant("已完成")]);
  try {
    await h.prompt("请创建一个持续目标");
    assert.equal(h.current()?.status, "complete"); assert.equal(h.current()?.tokenBudget, 1000);
    const result = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "get_goal");
    assert.match(JSON.stringify(result), /用户明确要求的目标/);
    assert.match(JSON.stringify(result), /remainingTokens/);
  } finally { await h.close(); }
});

test("budget crossing during a tool exchange injects wrap-up steering and accounts the wrap-up", async () => {
  const get = { ...assistant("", "toolUse"), content: [{ type: "toolCall", id: "get", name: "get_goal", arguments: {} }] };
  const h = await harness([get, assistant("已收尾，剩余工作待增加预算"), assistant("普通新任务")], { entries: [{ ...newGoal("预算目标", 2), status: "paused" }] });
  try {
    await h.prompt("/goal resume");
    assert.equal(h.calls(), 2); assert.equal(h.current()?.status, "budget_limited"); assert.equal(h.current()?.tokensUsed, 4);
    assert.match(JSON.stringify(h.contexts[1]), /do not start new substantive work/);
    assert.doesNotMatch(JSON.stringify(h.contexts[1]), /Completion audit/);
    await h.prompt("解释这个新问题");
    assert.doesNotMatch(JSON.stringify(h.contexts[2]), /do not start new substantive work/);
    assert.equal(h.current()?.tokensUsed, 4);
  } finally { await h.close(); }
});

test("real in-flight Stop and /goal pause stop work without an automatic continuation", { timeout: 10000 }, async () => {
  for (const method of ["abort", "command"] as const) {
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const h = await harness([assistant("执行中")], { onRequest: async (_call, signal) => {
      started();
      if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    } });
    try {
      await h.session.prompt("/goal 持续执行");
      await waiting;
      if (method === "abort") await h.session.abort();
      else await h.session.prompt("/goal pause");
      await h.session.waitForIdle();
      assert.equal(h.calls(), 1); assert.equal(h.current()?.status, "paused");
    } finally { await h.close(); }
  }
});

test("clear during a request cannot be resurrected by its late completion", { timeout: 10000 }, async () => {
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness([assistant("最后一次进展")], { onRequest: async () => { started(); await gate; } });
  try {
    await h.session.prompt("/goal 持续执行"); await waiting;
    await h.session.prompt("/goal clear"); release(); await h.session.waitForIdle();
    assert.equal(h.current(), null); assert.equal(h.calls(), 1);
    await h.session.reload(); assert.equal(h.statuses.at(-1), null);
  } finally { release(); await h.close(); }
});

test("pause immediately followed by resume waits for old cancellation before starting again", { timeout: 10000 }, async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const h = await harness([assistant("旧请求"), update("complete"), assistant("新运行完成")], { onRequest: async (call, signal) => {
    if (call !== 1) return;
    started();
    if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  } });
  try {
    await h.session.prompt("/goal 持续执行"); await waiting;
    await Promise.all([h.session.prompt("/goal pause"), h.session.prompt("/goal resume")]);
    await h.session.waitForIdle();
    assert.equal(h.calls(), 3); assert.equal(h.current()?.status, "complete");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("tool activity before an empty final assistant is not an empty goal turn", async () => {
  const work = Array.from({ length: 3 }, (_, i) => [
    { ...assistant("", "toolUse"), content: [{ type: "toolCall", id: `get-${i}`, name: "get_goal", arguments: {} }] }, assistant(""),
  ]).flat();
  await withGoal([...work, update("complete"), assistant("完成")], (h) => {
    assert.equal(h.calls(), 8); assert.equal(h.current()?.status, "complete");
    assert.equal(h.statuses.some((g) => g?.status === "blocked"), false);
  });
});

test("loading and navigating an active goal preserve status without making a provider request", async () => {
  const h = await harness([update("complete"), assistant("完成")], { entries: [newGoal("重开目标")] });
  try {
    assert.equal(h.calls(), 0); assert.equal(h.current()?.status, "active");
    assert.equal(h.statuses.at(-1)?.status, "active");
    await h.session.reload();
    assert.equal(h.calls(), 0); assert.equal(h.current()?.status, "active");
    await h.prompt("继续这个目标");
    assert.equal(h.current()?.status, "complete");
  } finally { await h.close(); }
});

test("stopped goals can be completed directly with final usage in the tool response", async () => {
  for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const) {
    const h = await harness([update("complete"), assistant("验收通过")], { entries: [{ ...newGoal("外部已完成", 100), status, tokensUsed: 17 }] });
    try {
      await h.prompt("请验收外部结果并标记完成");
      assert.equal(h.current()?.status, "complete");
      const output = h.session.messages.find((m) => m.role === "toolResult");
      assert.equal(output?.role === "toolResult" && output.isError, false);
      const result = JSON.parse((output as any).content[0].text);
      assert.equal(result.remainingTokens, 83);
      assert.equal(result.goal.remainingTokens, undefined);
      assert.match(result.completionBudgetReport, /Report final usage/);
    } finally { await h.close(); }
  }
});

test("reasoning activity resets the automatic empty-turn guard", async () => {
  const thinking = { ...assistant(""), content: [{ type: "thinking", thinking: "核实一项要求，继续下一项" }] };
  await withGoal([assistant(""), assistant(""), assistant(""), thinking, assistant(""), assistant(""), update("complete"), assistant("完成")], (h) => {
    assert.equal(h.calls(), 8); assert.equal(h.current()?.status, "complete");
    assert.equal(h.statuses.some((g) => g?.status === "blocked"), false);
  });
});

test("three execution-backend failure turns block even across an intervening text-only turn", async () => {
  await withGoal([call("bash"), assistant("缺少shell"), assistant("重新检查环境"), call("bash"), assistant("仍不可用"), call("bash"), assistant("需要修复环境")], (h) => {
    assert.equal(h.calls(), 7); assert.equal(h.current()?.status, "blocked");
    assert.equal(h.session.messages.filter((m) => m.role === "toolResult" && m.isError).length, 3);
  }, { extensions: [shellFixture(["unavailable", "unavailable", "unavailable"])] });
});

test("a successful tool resets execution-failure protection; command exits never count", async () => {
  const outcomes = ["unavailable", "unavailable", "success", "unavailable", "unavailable", "exit", "exit", "exit"] as const;
  await withGoal([...outcomes.flatMap(() => [call("bash"), assistant("检查下一步")]), update("complete"), assistant("完成")], (h) => {
    assert.equal(h.current()?.status, "complete");
    assert.equal(h.statuses.some((g) => g?.status === "blocked"), false);
  }, { extensions: [shellFixture([...outcomes])] });
});

test("pre-execution failures, aborted tools and normal failed exits are not unavailable environments", () => {
  const failure = { toolName: "bash", isError: true, durationMs: 1, result: { content: [{ type: "text", text: "spawn /missing ENOENT" }] } };
  assert.equal(executionUnavailable(failure), true);
  assert.equal(executionUnavailable({ ...failure, durationMs: undefined }), false);
  assert.equal(executionUnavailable({ ...failure, toolName: "read" }), false);
  assert.equal(executionUnavailable({ ...failure, result: { content: [{ type: "text", text: "Command aborted" }] } }), false);
  assert.equal(executionUnavailable({ ...failure, result: { ...failure.result, structuredContent: { exit_code: 1 } } }), false);
});

test("active elapsed time includes tools, excludes paused/offline spans and uses a monotonic clock", () => {
  let now = 10;
  const clock = new GoalClock(() => now);
  clock.reset(7); assert.equal(clock.sample(true), 7);
  now += 1200; assert.equal(clock.sample(true), 8);
  now += 900; assert.equal(clock.sample(false), 9);
  now += 100_000; assert.equal(clock.sample(false), 9);
  assert.equal(clock.sample(true), 9);
  now += 1000; assert.equal(clock.sample(false), 10);
  clock.reset(10); now += 100_000; assert.equal(clock.sample(true), 10);
});

test("a long tool contributes to goal elapsed time and completion report", async () => {
  const work = (pi: ExtensionAPI) => pi.registerTool({ name: "wait_for_work", label: "Wait", description: "Wait fixture", parameters: { type: "object", properties: {} } as never,
    async execute() { await new Promise((resolve) => setTimeout(resolve, 1100)); return { content: [{ type: "text", text: "finished" }], details: {} }; },
  });
  await withGoal([call("wait_for_work"), update("complete"), assistant("完成")], (h) => {
    assert.ok(h.current()!.timeUsedSeconds >= 1);
    const output = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "update_goal");
    assert.match(JSON.stringify(output), /completionBudgetReport.*elapsed time/);
  }, { extensions: [work] });
});

test("descendant usage reaches the live budget, persists, and steers the next request", async () => {
  const usageHost = new GoalDescendantUsage();
  const bridge = usageHost.bridge("parent");
  const child = (pi: ExtensionAPI) => pi.registerTool({ name: "child_work", label: "Child", description: "Descendant request fixture", parameters: { type: "object", properties: {} } as never,
    async execute() {
      const report = usageHost.capture("parent");
      report({ input: 10, cacheWrite: 3, output: 7, cacheRead: 500 });
      report({ input: 10, output: 7 }); // duplicate completion must not charge twice
      return { content: [{ type: "text", text: "child finished" }], details: {} };
    },
  });
  const h = await harness([call("child_work"), assistant("预算已耗尽，汇报进度")], { entries: [newGoal("共享预算", 10)], extensions: [child], goalAccounting: () => bridge });
  try {
    await h.prompt("执行目标");
    assert.equal(h.calls(), 2); assert.equal(h.current()?.status, "budget_limited");
    assert.equal(h.current()?.tokensUsed, 24);
    assert.match(JSON.stringify(h.contexts[1]), /do not start new substantive work/);
    await h.session.reload();
    assert.equal(h.current()?.tokensUsed, 24);
    assert.equal(h.statuses.at(-1)?.tokensUsed, 24);
  } finally { await h.close(); }
});

test("late descendant usage keeps its paused goal, never charges a replacement or revives clear", async () => {
  const usageHost = new GoalDescendantUsage();
  const bridge = usageHost.bridge("parent");
  const h = await harness([update("complete"), assistant("新目标完成")], { entries: [newGoal("旧目标")], goalAccounting: () => bridge });
  try {
    const beforePause = usageHost.capture("parent");
    const beforeClear = usageHost.capture("parent");
    await h.prompt("/goal pause");
    beforePause({ input: 6, output: 4 });
    assert.equal(h.current()?.status, "paused"); assert.equal(h.current()?.tokensUsed, 10);
    await h.prompt("/goal clear");
    await h.prompt("/goal 新目标");
    const newUsage = h.current()?.tokensUsed;
    beforeClear({ input: 100, output: 50 });
    assert.equal(h.current()?.objective, "新目标"); assert.equal(h.current()?.tokensUsed, newUsage);
    await h.prompt("/goal clear");
    beforeClear({ input: 100 });
    assert.equal(h.current(), null);
  } finally { await h.close(); }
});

test("idle descendant budget crossing stops the goal without starting another request", async () => {
  const usageHost = new GoalDescendantUsage();
  const bridge = usageHost.bridge("parent");
  const h = await harness([], { entries: [newGoal("后台子任务", 5)], goalAccounting: () => bridge });
  try {
    usageHost.capture("parent")({ input: 3, output: 4 });
    assert.equal(h.current()?.status, "budget_limited"); assert.equal(h.current()?.tokensUsed, 7);
    assert.equal(h.calls(), 0);
    await h.session.reload();
    assert.equal(h.current()?.tokensUsed, 7);
  } finally { await h.close(); }
});

test("optional host maximum supplies a default and rejects larger budgets", async () => {
  assert.equal(newGoal("goal", undefined, 100).tokenBudget, 100);
  assert.throws(() => newGoal("goal", 101, 100), /maximum/);
  assert.equal((goalResult(null) as any).remainingTokens, null);
  const original = process.env.FASTVIBE_MAX_GOAL_TOKEN_BUDGET;
  process.env.FASTVIBE_MAX_GOAL_TOKEN_BUDGET = "100";
  const h = await harness([call("create_goal", { objective: "目标", token_budget: 101 }), call("create_goal", { objective: "目标" }), update("complete"), assistant("完成")]);
  try {
    await h.prompt("创建目标");
    assert.equal(h.current()?.tokenBudget, 100);
    assert.equal(h.current()?.status, "complete");
    assert.ok(h.session.messages.some((m) => m.role === "toolResult" && m.isError && /maximum/.test(JSON.stringify(m))));
  } finally { await h.close(); if (original === undefined) delete process.env.FASTVIBE_MAX_GOAL_TOKEN_BUDGET; else process.env.FASTVIBE_MAX_GOAL_TOKEN_BUDGET = original; }
});
