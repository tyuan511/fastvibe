import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { BotConversationPreviewReader, botConversationPreview } from "../src/main/bot/bot-conversation-preview.ts";
import { TranscriptReader } from "../src/main/engine/transcript-reader.ts";
import { openDatabase } from "../src/main/engine/db.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import type { BotHost } from "../src/shared/bot.ts";

const timestamp = "2026-11-02T00:00:00.000Z";
const at = Date.parse(timestamp);
function message(id: string, role: string, content: unknown, parentId: string | null = null, time = timestamp): SessionEntry {
  return { type: "message", id, parentId, timestamp: time, message: { role, content, timestamp: Date.parse(time) } } as SessionEntry;
}
const assistant = (text: string, id = "a", parentId: string | null = null) => message(id, "assistant", [{ type: "text", text }], parentId);
function transcript(text: string): string {
  return [
    { type: "session", version: 3, id: "preview-session", timestamp, cwd: "/tmp" },
    assistant(text),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("latest reply comes from assistant prose, not trailing tools, thinking or custom context", () => {
  const branch = [
    assistant("old", "old"),
    message("new", "assistant", [{ type: "thinking", thinking: "private thought" }, { type: "text", text: " \n最新  回复\t正文\n\n<oai-mem-citation>private memory ids</oai-mem-citation>" }], "old"),
    message("thinking", "assistant", [{ type: "thinking", thinking: " " }, { type: "text", text: "\n\t " }], "new"),
    message("call", "assistant", [{ type: "toolCall", name: "bash", arguments: { command: "secret" }, id: "tool" }], "thinking"),
    message("result", "toolResult", [{ type: "text", text: "secret result" }], "call"),
    { type: "custom_message", id: "custom", parentId: "result", timestamp, customType: "internal", display: false, content: "hidden context" } as SessionEntry,
  ];
  assert.deepEqual(botConversationPreview(branch), { text: "最新 回复 正文", updatedAt: at });
  assert.equal(botConversationPreview(branch.slice(2)), undefined);
  assert.equal(botConversationPreview([assistant("<oai-mem-citation>private</oai-mem-citation>")]), undefined);
});

test("preview is bounded to 400 UTF-16 characters and keeps the assistant entry's time", () => {
  const branch = [message("a", "assistant", [{ type: "text", text: "字".repeat(399) + "😀tail" }], null, "2026-11-02T01:02:03.000Z")];
  branch[0].type === "message" && (branch[0].message.timestamp = 1);
  assert.deepEqual(botConversationPreview(branch), { text: "字".repeat(399), updatedAt: at + 3_723_000 });
  assert.equal(botConversationPreview([assistant("x".repeat(1000))])?.text.length, 400);
});

test("live branches are read per conversation and never load or cache a complete transcript", async () => {
  const branches = new Map([["worker-a", [assistant("A reply")]], ["worker-b", [assistant("B reply")]]]);
  const reader = new BotConversationPreviewReader((id) => {
    const branch = branches.get(id);
    return branch ? { branch } : undefined;
  }, async () => { throw new Error("live sources must not read disk"); });
  assert.deepEqual(await reader.read(["worker-a", "worker-b", "missing"]), {
    "worker-a": { text: "A reply", updatedAt: at }, "worker-b": { text: "B reply", updatedAt: at },
  });
  branches.set("worker-a", [assistant("A new reply")]);
  assert.equal((await reader.read(["worker-a"]))["worker-a"].text, "A new reply");
});

test("cold transcript loading follows the selected branch, is read-only, and caches only unchanged files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vivi-preview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  const raw = [
    { type: "session", version: 3, id: "cold", timestamp, cwd: dir },
    message("u", "user", [{ type: "text", text: "question" }]),
    assistant("unselected branch", "other", "u"),
    assistant("selected branch", "selected", "u"),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(file, raw);
  let reads = 0;
  const transcripts = new TranscriptReader();
  const reader = new BotConversationPreviewReader(() => ({ file, cwd: dir }), async (...args) => {
    reads++;
    return transcripts.read(...args);
  });
  const before = await stat(file);
  assert.equal((await reader.read(["worker"]))["worker"].text, "selected branch");
  assert.equal((await reader.read(["worker"]))["worker"].text, "selected branch");
  assert.equal(reads, 1);
  assert.equal(await readFile(file, "utf8"), raw);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);

  await writeFile(file, transcript("new reply with changed size"));
  await utimes(file, before.atime, before.mtime);
  assert.equal((await reader.read(["worker"]))["worker"].text, "new reply with changed size");
  assert.equal(reads, 2, "size alone invalidates the cache");
  const unchangedSize = (await stat(file)).size;
  await writeFile(file, transcript("NEW reply with changed size"));
  await utimes(file, before.atime, new Date(before.mtimeMs + 2000));
  assert.equal((await stat(file)).size, unchangedSize);
  assert.equal((await reader.read(["worker"]))["worker"].text, "NEW reply with changed size");
  assert.equal(reads, 3, "mtime alone invalidates the cache");
});

test("unreadable conversations are isolated and a failed parse is retried only after the file changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vivi-preview-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = join(dir, "bad.jsonl");
  await writeFile(bad, "invalid");
  let reads = 0;
  const transcripts = new TranscriptReader();
  const reader = new BotConversationPreviewReader((id) => {
    if (id === "good") return { branch: [assistant("good reply")] };
    if (id === "source-error") throw new Error("gone");
    return { file: id === "bad" ? bad : join(dir, "missing"), cwd: dir };
  }, async (...args) => { reads++; return transcripts.read(...args); });
  for (let n = 0; n < 2; n++) assert.deepEqual(await reader.read(["bad", "missing", "good", "source-error"]), { good: { text: "good reply", updatedAt: at } });
  assert.equal(reads, 1);
  await writeFile(bad, transcript("repaired reply"));
  assert.equal((await reader.read(["bad"]))["bad"].text, "repaired reply");
  assert.equal(reads, 2);
});

test("overlapping snapshots share reads and cold loads stay limited to four", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vivi-preview-parallel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ids = Array.from({ length: 12 }, (_, index) => `worker-${index}`);
  await Promise.all(ids.map((id) => writeFile(join(dir, id), "data")));
  let reads = 0; let active = 0; let peak = 0;
  const reader = new BotConversationPreviewReader((id) => ({ file: join(dir, id), cwd: dir }), async (file) => {
    reads++; active++; peak = Math.max(peak, active);
    await tick(); await tick();
    active--;
    return [assistant(file)];
  });
  const snapshots = await Promise.all([reader.read(ids), reader.read(ids), reader.read([...ids].reverse())]);
  assert.equal(reads, ids.length);
  assert.ok(peak <= 4, `observed ${peak} concurrent loads`);
  for (const snapshot of snapshots) for (const id of ids) assert.equal(snapshot[id].text, join(dir, id));
});

test("cold cache is bounded and a file changed while loading is not retained under an old stamp", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vivi-preview-lru-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ids = Array.from({ length: 129 }, (_, index) => `worker-${index}`);
  await Promise.all(ids.map((id) => writeFile(join(dir, id), "data")));
  let reads = 0;
  const reader = new BotConversationPreviewReader((id) => ({ file: join(dir, id), cwd: dir }), async (file) => { reads++; return [assistant(file)]; });
  for (const id of ids) await reader.read([id]);
  assert.equal(reads, 129);
  await reader.read([ids[128]]);
  assert.equal(reads, 129);
  await reader.read([ids[0]]);
  assert.equal(reads, 130, "oldest of 129 files was evicted");

  const changing = join(dir, "changing");
  await writeFile(changing, "old");
  let attempts = 0;
  const racing = new BotConversationPreviewReader(() => ({ file: changing, cwd: dir }), async () => {
    if (++attempts === 1) await writeFile(changing, "changed size");
    return [assistant("fresh")];
  });
  assert.deepEqual(await racing.read(["worker"]), {});
  assert.equal((await racing.read(["worker"]))["worker"].text, "fresh");
  assert.equal(attempts, 2);
});

test("SDK message_end 的 microtask 通知可立即读取刚持久化的 Worker 正文", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vivi-preview-sdk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const store = new BotStore(db);
  store.putConversation({ conversationId: "worker", role: "worker", owner: "vivi", creationKey: "work", epoch: 3, paused: false, createdAt: at, updatedAt: at });
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses([fauxAssistantMessage("第一条正文"), fauxAssistantMessage("第二条正文")]);
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noSkills: true, noContextFiles: true, noExtensions: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager: SessionManager.create(dir, dir), settingsManager, resourceLoader });
  t.after(() => session.dispose());
  const previews = new BotConversationPreviewReader(() => ({ branch: session.sessionManager.getBranch() }), async () => { throw new Error("must use live branch"); });
  const seen: Array<Promise<import("../src/shared/bot.ts").WorkSnapshot>> = [];
  const bot = new BotRuntime(store, {
    createConversation: async () => "unused", execute: async () => ({ status: "completed", text: "" }),
    snapshot: async () => { throw new Error("unused"); }, messages: async () => [], abort: async () => {}, resolveProject: () => dir,
    conversationPreviews: (ids) => previews.read(ids),
    changed: () => seen.push(bot.getWorkSnapshot()),
  });
  session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const ended = event.message;
    assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message === ended), false);
    queueMicrotask(() => {
      assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message === ended));
      bot.conversationUpdated("worker");
    });
  });
  for (const [index, text] of ["第一条正文", "第二条正文"].entries()) {
    await session.prompt("继续");
    const snapshot = await seen[index];
    assert.equal(snapshot.revision, index + 1);
    assert.equal(snapshot.conversationPreviews?.worker.text, text);
    const disk = await readFile(session.sessionFile!, "utf8");
    assert.ok(disk.includes(text), "通知发出时正文已写入转写文件");
    assert.deepEqual(snapshot.messages, []);
    assert.equal(snapshot.conversations[0].epoch, 3);
  }
});

test("snapshot captures durable facts and revision before awaiting worker previews", async () => {
  const db = openDatabase(":memory:");
  const store = new BotStore(db);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested: string[] = [];
  const host: BotHost = {
    createConversation: async () => ({ conversationId: "unused" }), execute: async () => ({ status: "completed", text: "" }),
    snapshot: async () => { throw new Error("must not load a session"); }, messages: async () => { throw new Error("must not load messages"); },
    abort: async () => {}, resolveProject: () => "/tmp", changed: () => {},
    conversationPreviews: async (ids) => { requested = ids; await gate; return { worker: { text: "latest reply", updatedAt: at } }; },
  };
  const bot = new BotRuntime(store, host);
  try {
    for (const role of ["router", "worker"] as const) store.putConversation({ conversationId: role, role, owner: "vivi", creationKey: role, epoch: 0, paused: false, createdAt: at, updatedAt: at });
    const revision = store.bumpRevision();
    const pending = bot.getWorkSnapshot();
    assert.deepEqual(requested, ["worker"]);
    store.transaction(() => {
      store.putConversation({ ...store.conversation("worker")!, title: "changed while reading" });
      store.putChatMessage({ id: "new-feed", conversationId: "router", role: "assistant", text: "new feed", createdAt: at + 1 });
      store.bumpRevision();
    });
    release();
    const snapshot = await pending;
    assert.equal(snapshot.revision, revision);
    assert.equal(snapshot.conversations.find((item) => item.conversationId === "worker")?.title, undefined);
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.conversationPreviews, { worker: { text: "latest reply", updatedAt: at } });
    assert.equal((await bot.getWorkSnapshot()).revision, revision + 1);
    host.conversationPreviews = async () => { throw new Error("preview service failed"); };
    assert.equal((await bot.getWorkSnapshot()).conversationPreviews, undefined);
  } finally { release(); await bot.stop(); db.close(); }
});
