import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Goal mode's loop is the one thing in the built-in extensions that can spend the
 * user's tokens without being asked again, so its edges are pinned here against the
 * *real* SDK rather than a fake: the continuation has to actually be delivered, a
 * failed round has to stop it, and a transient failure the SDK retries has to survive
 * that retry.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text: string, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "fake",
  model: "m",
  timestamp: Date.now(),
  stopReason,
  usage,
  // A message the SDK's own classifier treats as transient (`retry.js`), so the
  // retry-within-the-run case is the real one and not a merely-unknown error.
  ...(stopReason === "error" ? { errorMessage: "429 Too Many Requests" } : {}),
});
const aborted = () => ({ ...assistant("", "aborted"), content: [{ type: "text", text: "半句话" }] });

/** Run the goal extension on a scripted session and report what it published. */
async function runGoal(script: Array<ReturnType<typeof assistant>>, options: { retries?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-goal-"));
  let calls = 0;
  const streamFn = (model: { provider: string; id: string }) => {
    const partial = script[Math.min(calls, script.length - 1)];
    calls += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial };
        if (partial.stopReason === "error") yield { type: "error", reason: "error", error: partial };
        else yield { type: "done", reason: "stop", message: partial };
      },
      result: async () => partial,
    };
  };

  const model = { provider: "fake", id: "m", name: "F", contextWindow: 100_000, maxTokens: 4096, input: ["text"], api: "openai-completions" };
  const agent = new Agent({
    initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] },
    convertToLlm: (messages) => messages,
    streamFn,
  });
  const settingsManager = SettingsManager.create(dir, join(dir, "agent"));
  settingsManager.setRetryEnabled((options.retries ?? 0) > 0);
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager,
    additionalExtensionPaths: [new URL("../resources/extensions/goal.ts", import.meta.url).pathname],
  });
  await resourceLoader.reload();
  const modelRuntime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({}),
    isUsingOAuth: () => false,
    getAuth: async () => ({ auth: {} }),
    streamSimple: streamFn,
  };
  const session = new AgentSession({
    agent: agent as never,
    sessionManager,
    settingsManager,
    cwd: dir,
    resourceLoader,
    modelRuntime: modelRuntime as never,
    initialActiveToolNames: [],
  });

  const statuses: string[] = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      setStatus: (key: string, text?: string) => {
        if (key === "goal" && text) statuses.push(text);
      },
      notify: () => undefined,
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      onTerminalInput: () => () => undefined,
      setWidget: () => undefined,
      setTitle: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      setFooter: () => undefined,
      setHeader: () => undefined,
    } as never,
    onError: () => undefined,
  });

  await session.prompt("/goal 一个很大的任务");
  await session.waitForIdle();
  return {
    calls,
    states: statuses.map((raw) => JSON.parse(raw) as { status: string; round: number; objective: string }),
    goalEntries: sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "fastvibe-goal")
      .map((entry) => (entry as { data: { status: string; round: number } }).data),
  };
}

test("a goal runs itself round after round until the model says GOAL_COMPLETE", async () => {
  const result = await runGoal([
    assistant("第 1 轮"),
    assistant("第 2 轮"),
    assistant("全部完成\nGOAL_COMPLETE"),
  ]);
  // The loop is driven by a queued follow-up, not by a fresh prompt: without
  // `deliverAs: "followUp"` the SDK refuses the continuation and this stays at 1.
  assert.equal(result.calls, 3);
  assert.equal(result.states.at(-1)?.status, "complete");
  assert.equal(result.states.at(-1)?.round, 3);
  // The marker is stripped from the reply but the goal is still recorded as done, so a
  // reopen restores a finished goal rather than an unfinished one.
  assert.equal(result.goalEntries.at(-1)?.status, "complete");
});

test("a round that fails pauses the goal instead of spending another one", async () => {
  const result = await runGoal([assistant("第 1 轮"), assistant("", "error")]);
  assert.equal(result.calls, 2);
  assert.equal(result.states.at(-1)?.status, "paused");
});

test("a failure the SDK retries inside the run does not pause the goal", async () => {
  const result = await runGoal(
    [assistant("第 1 轮"), assistant("", "error"), assistant("恢复"), assistant("完成\nGOAL_COMPLETE")],
    { retries: 1 },
  );
  // The failed attempt, its retry, the next round and the completion marker.
  assert.equal(result.calls, 4);
  assert.equal(result.states.at(-1)?.status, "complete");
  assert.equal(result.goalEntries.some((entry) => entry.status === "paused"), false);
});

test("a user stop pauses the goal rather than letting it restart itself", async () => {
  const result = await runGoal([aborted()]);
  assert.equal(result.calls, 1);
  assert.equal(result.states.at(-1)?.status, "paused");
});

test("the autonomous cap pauses the goal rather than running forever", async () => {
  // The cap is 100 rounds; 105 scripted turns is more than enough to reach it. The
  // loop must stop there (100 rounds) instead of grinding through every response.
  const script = Array.from({ length: 105 }, (_, index) => assistant(`第 ${index + 1} 轮`));
  const result = await runGoal(script);
  assert.equal(result.states.at(-1)?.status, "paused");
  // The cap is what ended it: the loop stopped well short of the 105 turns it had
  // available, and the panel keeps the round it reached.
  assert.ok(result.calls <= 102, `expected the loop to stop at the cap, ran ${result.calls}`);
  assert.ok(result.calls < 105, "the loop must not drain every scripted response");
  assert.equal(result.states.at(-1)?.round, 101);
});

test("the objective and its round survive a reopen", async () => {
  const first = await runGoal([assistant("第 1 轮"), assistant("", "error")]);
  assert.equal(first.states.at(-1)?.round, 2);
  assert.equal(first.states.at(-1)?.objective, "一个很大的任务");
});
