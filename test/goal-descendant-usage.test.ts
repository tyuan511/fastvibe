import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { GoalDescendantUsage, trackGoalDescendantUsage, type GoalUsageEvent } from "../src/main/engine/goal-descendant-usage.ts";

const usage = { input: 7, output: 3, cacheWrite: 2, cacheRead: 100, totalTokens: 112, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("descendant requests own their original goal, are counted once, and exclude cached reads", () => {
  const ledger = new GoalDescendantUsage();
  const bridge = ledger.bridge("parent");
  const events: GoalUsageEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  bridge.setGoal("first");
  const first = ledger.capture("parent");
  const second = ledger.capture("parent");
  bridge.setGoal("replacement");
  first(usage); first(usage); second(usage);
  ledger.capture("parent")(usage);
  assert.deepEqual(events, [{ goalId: "first", tokens: 12 }, { goalId: "first", tokens: 12 }, { goalId: "replacement", tokens: 12 }]);
});

test("pause/clear stops new attribution without retargeting requests already sent", () => {
  const ledger = new GoalDescendantUsage();
  const bridge = ledger.bridge("parent");
  const events: GoalUsageEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  bridge.setGoal("goal");
  const late = ledger.capture("parent");
  bridge.setGoal(undefined);
  ledger.capture("parent")(usage);
  late(usage);
  assert.deepEqual(events, [{ goalId: "goal", tokens: 12 }]);
});

test("reload buffers usage and stale unsubscription cannot remove the new listener", () => {
  const ledger = new GoalDescendantUsage();
  const bridge = ledger.bridge("parent");
  bridge.setGoal("goal");
  const old: GoalUsageEvent[] = [];
  const next: GoalUsageEvent[] = [];
  const unsubscribe = bridge.subscribe((event) => old.push(event));
  unsubscribe();
  ledger.capture("parent")(usage);
  ledger.capture("parent")(usage);
  bridge.subscribe((event) => next.push(event));
  unsubscribe();
  ledger.capture("parent")(usage);
  assert.deepEqual(old, []);
  assert.deepEqual(next, [{ goalId: "goal", tokens: 24 }, { goalId: "goal", tokens: 12 }]);
});

test("conversation scopes and deletion/restart epochs isolate late callbacks", () => {
  const ledger = new GoalDescendantUsage();
  const a = ledger.bridge("a");
  const b = ledger.bridge("b");
  const events: GoalUsageEvent[] = [];
  a.setGoal("a-goal"); b.setGoal("b-goal");
  a.subscribe((event) => events.push(event)); b.subscribe((event) => events.push(event));
  const deleted = ledger.capture("a");
  ledger.delete("a");
  const replacement = ledger.bridge("a");
  replacement.setGoal("new-goal"); replacement.subscribe((event) => events.push(event));
  a.setGoal("stale"); deleted(usage);
  ledger.capture("a")(usage); ledger.capture("b")(usage);
  const stopped = ledger.capture("b");
  ledger.clear(); stopped(usage);
  assert.deepEqual(events, [{ goalId: "new-goal", tokens: 12 }, { goalId: "b-goal", tokens: 12 }]);
});

test("malformed usage cannot poison goal totals", () => {
  const ledger = new GoalDescendantUsage();
  const bridge = ledger.bridge("p");
  bridge.setGoal("g");
  const events: GoalUsageEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  ledger.capture("p")(undefined);
  ledger.capture("p")({ input: NaN, output: -1, cacheWrite: Infinity });
  ledger.capture("p")({ input: "500", output: 2 });
  assert.deepEqual(events, [{ goalId: "g", tokens: 2 }]);
});

test("duplicate assistant events cannot consume a newer request's attribution", async () => {
  const ledger = new GoalDescendantUsage();
  const bridge = ledger.bridge("p");
  const events: GoalUsageEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  bridge.setGoal("first");
  let listener: (event: unknown) => void = () => {};
  const agent = { onPayload: undefined as undefined | ((payload: unknown, model: unknown) => Promise<unknown>) };
  const stop = trackGoalDescendantUsage({ agent, subscribe: (fn: typeof listener) => { listener = fn; return () => {}; } } as never, () => ledger.capture("p"));
  const message = { role: "assistant", usage };
  await agent.onPayload!({}, {});
  listener({ type: "message_end", message });
  bridge.setGoal("second");
  await agent.onPayload!({}, {});
  listener({ type: "message_end", message });
  listener({ type: "message_end", message: { role: "assistant", usage } });
  assert.deepEqual(events, [{ goalId: "first", tokens: 12 }, { goalId: "second", tokens: 12 }]);
  stop();
});

test("real SDK: request attribution precedes reply start, includes failed usage, and ignores restored history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-descendants-"));
  const ledger = new GoalDescendantUsage();
  const bridge = ledger.bridge("parent");
  const events: GoalUsageEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  bridge.setGoal("first");
  let calls = 0;
  const reply = (failed: boolean) => ({ role: "assistant" as const, content: [{ type: "text" as const, text: "done" }], provider: "fake", model: "m", api: "openai-completions" as const, timestamp: Date.now(), stopReason: failed ? "error" as const : "stop" as const, errorMessage: failed ? "401 rejected" : undefined, usage });
  const runtime = await ModelRuntime.create({ credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("fake", {
    api: "openai-completions", apiKey: "unused", baseUrl: "http://fake.invalid",
    streamSimple: ((model: unknown, _context: unknown, options: { onPayload?: (payload: unknown, model: unknown) => Promise<unknown> }) => {
      const message = reply(++calls === 2);
      return { async *[Symbol.asyncIterator]() {
        await options.onPayload?.({}, model);
        // A new goal is selected while the first request waits for its first byte.
        if (calls === 1) bridge.setGoal("second");
        yield { type: "start", partial: message };
        if (message.stopReason === "error") yield { type: "error", reason: "error", error: message };
        else yield { type: "done", reason: "stop", message };
      }, result: async () => message };
    }) as never,
    models: [{ id: "m", name: "Fake", contextWindow: 100000, maxTokens: 1024, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const sessionManager = SessionManager.inMemory(dir);
  sessionManager.appendMessage(reply(false));
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, sessionManager, settingsManager, resourceLoader: loader, modelRuntime: runtime, model: runtime.getModel("fake", "m"), tools: [] });
  let forwarded = 0;
  session.agent.onPayload = () => { forwarded++; };
  const stop = trackGoalDescendantUsage(session, () => ledger.capture("parent"));
  try {
    assert.deepEqual(events, []);
    await session.prompt("one");
    await session.prompt("two");
    assert.deepEqual(events, [{ goalId: "first", tokens: 12 }, { goalId: "second", tokens: 12 }]);
    assert.equal(forwarded, 2);
    stop();
    await session.prompt("untracked");
    assert.equal(events.length, 2);
    assert.equal(forwarded, 3);
  } finally { stop(); await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
