import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { TranscriptReader } from "../src/main/engine/transcript-reader.ts";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { transcriptWindow, transcriptEntryEnd } from "../src/main/engine/transcript-window.ts";
import { previewTranscript } from "../src/shared/transcript-preview.ts";
import { summarizeToolCalls } from "../src/shared/tool-summary.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const module = { exports: {} };
const projection = ts.transpileModule(readFileSync(new URL("../src/main/pi/process-manager-transcript.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
new Function("module", "exports", "require", projection)(module, module.exports, (name: string) => ({
  "@earendil-works/pi-coding-agent": { sessionEntryToContextMessages },
  "../engine/map-messages": { mapEngineMessages },
  "./tui-bridge": { renderExtensionMessage: () => undefined },
  "./process-manager-events": { isRecord: (value: unknown) => value !== null && typeof value === "object" },
  "../engine/transcript-window": { transcriptWindow, transcriptEntryEnd },
  "../engine/tool-images": { externalizeToolResultMessages: (messages: unknown[]) => messages },
})[name]);
const projectSessionMessages = (module.exports as typeof import("../src/main/pi/process-manager-transcript.ts")).projectSessionMessages;
const hostSource = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("host.ts", hostSource, ts.ScriptTarget.Latest, true);
const wanted = new Set(["#readTranscript", "#messagesFrom", "getSnapshot", "getMessagesPage", "getMessage"]);
const methods: string[] = [];
function visit(node: import("typescript").Node) {
  if (ts.isMethodDeclaration(node) && wanted.has(node.name.getText(ast))) methods.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(methods.length, wanted.size);
const compiled = ts.transpileModule(`class Host {${methods.join("\n").replaceAll("#", "")}}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const Host = new Function("projectSessionMessages", "summarizeToolCalls", "previewTranscript", "uiText", `${compiled}; return Host;`)(
  projectSessionMessages, summarizeToolCalls, previewTranscript, (text: string) => text,
);
const stamp = "2026-10-16T00:00:00.000Z";
function entry(id: string, parentId: string | null, role: string, content: unknown) {
  return { type: "message", id, parentId, timestamp: stamp, message: { role, content, timestamp: 1 } };
}
function entries(turns: number, chars = 200) {
  const result: unknown[] = [{ type: "session", version: 3, id: "s", timestamp: stamp, cwd: "/tmp" }];
  for (let i = 0; i < turns; i++) {
    result.push(entry(`u${i}`, i ? `a${i - 1}` : null, "user", `question ${i}`));
    result.push(entry(`a${i}`, `u${i}`, "assistant", [{ type: "text", text: `answer ${i} ${"汉".repeat(chars)}` }]));
  }
  return result;
}
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0], rows = entries(20)) {
  const dir = await mkdtemp(join(tmpdir(), "fv-transcript-loading-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const host = new Host();
  Object.assign(host, {
    sessions: new Map(), sessionPromises: new Map(), catalog: { get: () => ({ sessionFile: file, cwd: dir }) },
    transcriptReader: new TranscriptReader(), working: () => false,
    sessionFor: () => { throw new Error("Reading history must not initialize an agent"); },
    running: new Map(), compacting: new Map(), reasoning: { get: () => undefined },
    openingPrompts: new Map(), pendingUi: new Map(), turnEvents: new Map(), eventSeq: 41,
    messageQueue: { state: () => ({ conversationId: "c", revision: 0, items: [], pause: null }) },
  });
  return { host, file, dir };
}

test("cold compact snapshots and every page read without creating an agent; cached windows preserve all history", async (t) => {
  const { host, file } = await fixture(t);
  const original = await readFile(file, "utf8");
  const latest = await host.getSnapshot("c", undefined, 3, "summary", { preview: true });
  assert.equal(latest.messages[0].id, "u17");
  assert.equal(latest.seq, 41);
  assert.ok(latest.timing.readMs >= 0);
  let cursor = latest.history.beforeEntryId;
  let all = latest.messages;
  while (cursor) {
    const page = await host.getMessagesPage("c", cursor, 3, "summary");
    assert.equal(page.reset, false);
    all = [...page.messages, ...all];
    cursor = page.nextBeforeEntryId;
  }
  assert.equal(all.length, 40);
  assert.equal(all[0].id, "u0");
  assert.equal(await readFile(file, "utf8"), original, "viewing cannot repair, migrate or rewrite the file");
});

test("a changed file invalidates cached history, including a fork that removes the old cursor", async (t) => {
  const { host, file } = await fixture(t);
  const first = await host.getSnapshot("c", undefined, 3, "summary");
  await writeFile(file, entries(2).map((row) => JSON.stringify(row)).join("\n") + "\n");
  const second = await host.getSnapshot("c", undefined, 3, "summary");
  assert.equal(second.messages.length, 4);
  assert.equal((await host.getMessagesPage("c", first.history.beforeEntryId, 3, "summary")).reset, true);
});

test("long text previews are explicit and lossless content can be fetched without later turns", async (t) => {
  const { host } = await fixture(t, entries(5, 50_000));
  const latest = await host.getSnapshot("c", undefined, 3, "summary", { preview: true, maxBytes: 16_384 });
  const answer = latest.messages.find((row: { role: string }) => row.role === "assistant");
  assert.equal(answer.deferredContent, true);
  assert.ok(answer.text.length <= 12_000);
  const full = await host.getMessage("c", answer.id);
  assert.equal(full.message.deferredContent, undefined);
  assert.ok(full.message.text.length > answer.text.length);
  assert.ok(full.message.text.endsWith(answer.text));
  assert.deepEqual(Object.keys(full).sort(), ["conversationId", "message"]);
  await assert.rejects(host.getMessage("c", "removed-entry"), /no longer on this branch/);
});

test("a missing tail anchor falls back to a bounded authoritative window", async (t) => {
  const { host } = await fixture(t);
  const result = await host.getSnapshot("c", "removed-entry", undefined, "summary", { preview: true });
  assert.equal(result.messageMode, "window");
  assert.equal(result.messages[0].id, "u17");
});

test("a session created during the file read wins, and snapshot seq/queue match the projected live content", async (t) => {
  const { host } = await fixture(t);
  let release!: (entries: unknown[]) => void;
  host.transcriptReader = { read: () => new Promise((resolve) => { release = resolve; }) };
  const pending = host.getSnapshot("c", undefined, 3, "summary");
  const branch = entries(1).slice(1);
  host.sessions.set("c", { session: {
    sessionManager: { getBranch: () => { host.eventSeq = 99; return branch; } },
    extensionRunner: { getMessageRenderer: () => undefined }, state: {}, messages: [],
  } });
  host.messageQueue = { state: () => ({ revision: host.eventSeq }) };
  release(entries(2).slice(1));
  const result = await pending;
  assert.equal(result.messages.length, 2);
  assert.equal(result.seq, 99);
  assert.equal(result.queue.revision, 99);
});

test("previews defer inline image bytes and large thoughts while preserving small text and live messages", () => {
  const small = { id: "u", role: "user" as const, text: "hello", tools: [], createdAt: 1 };
  const image = { ...small, attachments: [{ id: "photo", kind: "image" as const, name: "photo", dataUrl: `data:image/png;base64,${"a".repeat(200_000)}` }] };
  const [preview] = previewTranscript([image]);
  assert.equal(preview.text, "hello");
  assert.equal(preview.deferredContent, true);
  assert.equal(preview.attachments?.[0].dataUrl, undefined);
  assert.ok(image.attachments[0].dataUrl.length > 200_000);
  assert.equal(previewTranscript([small])[0], small);
  const live = { ...image, id: "running:c" };
  assert.equal(previewTranscript([live])[0], live);
  assert.equal(previewTranscript([{ ...image, role: "assistant" }], 12_000, true)[0].deferredContent, undefined, "the live reducer must retain its full prefix between model round trips");
  const thoughts = { ...small, thinking: "x".repeat(80_000) };
  assert.equal(previewTranscript([thoughts])[0].thinking, undefined);
});

test("oversized transcripts are not retained; corrupt parent cycles fail without rewriting", async (t) => {
  const { file, dir } = await fixture(t);
  const reader = new TranscriptReader(1);
  assert.notEqual(await reader.read(file, dir), await reader.read(file, dir));
  const cyclic = [entries(0)[0], entry("a", "b", "user", "a"), entry("b", "a", "assistant", "b")];
  await writeFile(file, cyclic.map((row) => JSON.stringify(row)).join("\n"));
  await assert.rejects(reader.read(file, dir), /cycle/);
});


test("a representative long-history first window is substantially smaller without losing deferred content", async (t) => {
  const { host } = await fixture(t, entries(100, 20_000));
  const before = await host.getSnapshot("c", undefined, 12, "summary");
  const after = await host.getSnapshot("c", undefined, 3, "summary", { preview: true, maxBytes: 128 * 1024 });
  const originalBytes = Buffer.byteLength(JSON.stringify(before.messages));
  const previewBytes = Buffer.byteLength(JSON.stringify(after.messages));
  assert.ok(previewBytes < originalBytes / 5);
  t.diagnostic(`Synthetic JSON payload: ${originalBytes} -> ${previewBytes} bytes (${(100 * (1 - previewBytes / originalBytes)).toFixed(1)}% smaller); not a device/network timing.`);
});
