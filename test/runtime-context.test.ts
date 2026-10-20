import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { runtimeContextExtension } from "../src/main/engine/runtime-context.ts";

const customType = "fastvibe-test-context";
type Message = { role: string; customType?: string; content: unknown };

async function harness(t: TestContext, extension?: ExtensionFactory) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { content: "first folders", enabled: true };
  const requests: Message[][] = [];
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 25 }, () => () => fauxAssistantMessage("done")));
  const runtime = await ModelRuntime.create({
    credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused",
    streamSimple: ((model: unknown, context: { messages: Message[] }, options: unknown) => {
      requests.push(structuredClone(context.messages));
      return (faux.streamSimple as (...args: unknown[]) => unknown)(model, context, options);
    }) as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noSkills: true, noContextFiles: true,
    extensionFactories: [{ name: "runtime-context", hidden: true, factory: runtimeContextExtension({ customType, title: "project folders",
      enabled: () => state.enabled,
      read: async () => state.content ? { content: state.content, systemPrompt: "Stable host rules." } : undefined,
    }) }, ...(extension ? [{ name: "cancel-start", hidden: true, factory: extension }] : [])],
  });
  await resourceLoader.reload();
  let sessionManager = SessionManager.create(cwd, join(dir, "sessions"));
  const open = async () => (await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
    model: runtime.getModel("faux", "scripted"), sessionManager, settingsManager, resourceLoader })).session;
  let session = await open();
  t.after(() => session.dispose());
  const snapshots = () => sessionManager.buildSessionProjection().messages.filter(
    (message) => message.role === "custom" && message.customType === customType,
  );
  return { state, requests, get session() { return session; }, get sessionManager() { return sessionManager; }, snapshots,
    reopen: async () => {
      const file = session.sessionFile!;
      session.dispose();
      sessionManager = SessionManager.open(file);
      await resourceLoader.reload();
      session = await open();
    },
  };
}

test("changing host facts preserves the previous provider prefix and the system prompt", async (t) => {
  const h = await harness(t);
  await h.session.prompt("first");
  const first = h.requests.at(-1)!;
  assert.match(JSON.stringify(first), /first folders/);
  h.state.content = "second folders";
  await h.session.prompt("second");
  const second = h.requests.at(-1)!;
  assert.deepEqual(second.slice(0, first.length), first);
  assert.deepEqual(second.filter((message) => message.role === "system"), first.filter((message) => message.role === "system"));
  assert.equal(h.snapshots().length, 2);
  assert.ok(h.snapshots().every((message) => message.role === "custom" && message.display === false));
  await h.session.prompt("unchanged");
  assert.equal(h.snapshots().length, 2, "unchanged facts do not grow history");
});

test("reload and branch use persisted snapshots, while compaction and context edits allow reinjection", async (t) => {
  const h = await harness(t);
  await h.session.prompt("first");
  const firstLeaf = h.sessionManager.getLeafId()!;
  h.state.content = "second folders";
  await h.session.prompt("second");
  await h.reopen();
  await h.session.prompt("after reopen");
  assert.equal(h.snapshots().length, 2, "disk restoration does not duplicate the last snapshot");
  await h.session.reload();
  await h.session.prompt("after reload");
  assert.equal(h.snapshots().length, 2);

  h.sessionManager.branch(firstLeaf);
  await h.session.reload();
  await h.session.prompt("after branch");
  assert.equal(h.snapshots().length, 2, "branch gets the current facts even if another branch already had them");
  const latest = h.sessionManager.getBranch().findLast((entry) => entry.type === "custom_message" && entry.customType === customType)!;
  h.sessionManager.appendContextEdit(latest.id, null);
  await h.session.reload();
  await h.session.prompt("after omission");
  assert.equal(h.snapshots().length, 2, "an omitted snapshot does not suppress the next update");

  const lastUser = h.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
  h.sessionManager.appendCompaction("earlier work", lastUser.id, 1000);
  await h.session.reload();
  await h.session.prompt("after compaction");
  assert.equal(h.snapshots().length, 1, "the current snapshot is restored after older ones were summarized");
  assert.match(JSON.stringify(h.requests.at(-1)), /second folders/);
});

test("disabled and removed sources leave no old snapshots in provider requests", async (t) => {
  const h = await harness(t);
  await h.session.prompt("first");
  h.state.enabled = false;
  await h.session.prompt("disabled");
  assert.doesNotMatch(JSON.stringify(h.requests.at(-1)), /first folders/);
  h.state.enabled = true;
  await h.session.prompt("enabled again");
  assert.match(JSON.stringify(h.requests.at(-1)), /first folders/);
  assert.equal(h.snapshots().length, 1, "reenabling reuses the persisted snapshot");
  h.state.content = "";
  await h.session.prompt("removed");
  assert.doesNotMatch(JSON.stringify(h.requests.at(-1)), /first folders/);
});

test("a run cancelled before committing context does not suppress its retry", async (t) => {
  let cancel = true;
  const h = await harness(t, (pi) => {
    pi.on("before_agent_start", (_event, ctx) => {
      if (cancel) { cancel = false; ctx.abort(); }
    });
  });
  await h.session.prompt("cancelled");
  assert.equal(h.requests.length, 0);
  await h.session.prompt("retry");
  assert.match(JSON.stringify(h.requests.at(-1)), /first folders/);
  assert.equal(h.snapshots().length, 1);
});
