import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { SUGGESTION_TURN, buildCacheContext } from "../src/main/engine/reply-suggestion.ts";

/**
 * `cache` mode only pays off if the request it sends starts with exactly the bytes the agent's
 * last request did — a provider's prompt cache is a prefix match. So this runs the real SDK, takes
 * the context `buildCacheContext` builds after one reply, then lets the agent make its own next
 * request and compares: the suggestion context minus its final turn must be a prefix of it.
 */
test("the cache-mode context is a prefix of the agent's own next request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reply-suggestion-"));
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  const requests: unknown[][] = [];
  faux.setResponses(Array.from({ length: 4 }, () => () => fauxAssistantMessage("done")));
  const runtime = await ModelRuntime.create({
    credentials: undefined,
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid",
    api: "faux-api" as never,
    apiKey: "unused",
    streamSimple: ((model: unknown, context: { messages: unknown[] }, options: unknown) => {
      requests.push(JSON.parse(JSON.stringify(context.messages)));
      return (faux.streamSimple as (...args: unknown[]) => unknown)(model, context, options);
    }) as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("faux", "scripted"),
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
  });
  try {
    await session.prompt("first question");
    const context = await buildCacheContext(session.agent);
    const own = JSON.parse(JSON.stringify(context.messages)) as Array<{ role: string; content: unknown }>;

    // The agent's own next request.
    await session.prompt("second question");
    const next = requests.at(-1)!;

    const last = own.at(-1)!;
    assert.equal(last.role, "user");
    assert.equal(last.content, SUGGESTION_TURN, "the ask is the final turn");
    const prefix = own.slice(0, -1);
    assert.ok(prefix.length >= 3, "system message, first question and its reply are all in the prefix");
    assert.equal((prefix[0] as { role: string }).role, "system", "the system message (prompt and tools) leads");
    // timestamps of assistant/user messages are part of the objects, so deep equality is the real test
    assert.deepEqual(next.slice(0, prefix.length), prefix, "the prefix is byte-identical to the agent's own next request");
  } finally {
    session.dispose();
  }
});
