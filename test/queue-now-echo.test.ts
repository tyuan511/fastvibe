import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as attachmentMetadata from "../src/shared/attachment-metadata.ts";
import * as toolResult from "../src/shared/tool-result.ts";
import type { ChatMessage, EngineEvent } from "../src/shared/types.ts";
import {
  applyAroundSentNow,
  optimisticQueuedTurn,
  preserveOptimisticTail,
  retractOptimisticTurn,
  type SentNow,
} from "../src/renderer/src/stores/session-reducer.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/renderer/src/lib/apply-engine-event.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
type Step = { messages: ChatMessage[]; streaming: boolean; interrupted?: "aborted" | "error"; partBoundary?: number };
const exports: { applyEngineEvent?: (messages: ChatMessage[], event: EngineEvent, streaming: boolean, boundary?: number) => Step } = {};
new Function("require", "exports", compiled)((name: string) => {
  if (name === "@shared/attachment-metadata") return attachmentMetadata;
  if (name === "@shared/tool-result") return toolResult;
  if (name.endsWith("random.ts")) return { randomUUID };
  if (name === "@/lib/i18n") return { i18n: { t: (key: string) => key } };
  throw new Error(`Unexpected dependency: ${name}`);
}, exports);

test("a reply placeholder counts from the prompt, not from the event that rebuilt it", () => {
  const row = (id: string, role: "user" | "assistant", text: string, createdAt: number): ChatMessage =>
    ({ id, role, text, tools: [], parts: text ? [{ kind: "text", text }] : [], createdAt });
  const before = Date.now();
  const next = exports.applyEngineEvent!(
    [row("u1", "user", "do the thing", 1_000)],
    { type: "agent_start" } as EngineEvent,
    false,
  ).messages;
  assert.equal(next.at(-1)?.role, "assistant");
  assert.equal(next.at(-1)?.createdAt, 1_000);
  assert.ok(before <= Date.now());
});

test("the engine's echo of a 立即 turn does not draw a second user row", () => {
  const row = (id: string, role: "user" | "assistant", text: string): ChatMessage =>
    ({ id, role, text, tools: [], parts: text ? [{ kind: "text", text }] : [], createdAt: 1 });
  // showQueuedNow: `queue:` user row plus the placeholder reply.
  const shown = optimisticQueuedTurn({ id: "q1", text: "next" });
  const echoed = exports.applyEngineEvent!(
    shown,
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "next" }] } } as EngineEvent,
    true,
  ).messages;
  assert.equal(echoed.filter((message) => message.role === "user").length, 1);
});

const line = (id: string, role: "user" | "assistant", text: string): ChatMessage =>
  ({ id, role, text, tools: [], parts: text ? [{ kind: "text", text }] : [], createdAt: 1 });
const ev = (type: string, extra: Record<string, unknown> = {}): EngineEvent =>
  ({ type, conversationId: "chat", ...extra }) as EngineEvent;
const delta = (text: string): EngineEvent =>
  ev("message_update", { assistantMessageEvent: { type: "text_delta", delta: text } });
const aborted = { role: "assistant", content: [], stopReason: "aborted" };

/** The store's own loop over `applyAroundSentNow`, against the real transcript reducer. */
function play(start: { messages: ChatMessage[]; sentNow: SentNow | null; streaming?: boolean }, events: EngineEvent[]) {
  let view = { messages: start.messages, streaming: start.streaming ?? true, boundary: 0, sentNow: start.sentNow };
  let interrupted: string | undefined;
  for (const event of events) {
    const applied = applyAroundSentNow(view, event, exports.applyEngineEvent!);
    if (applied.interrupted) interrupted = applied.interrupted;
    view = { messages: applied.messages, streaming: applied.streaming, boundary: applied.partBoundary ?? view.boundary, sentNow: applied.sentNow };
  }
  return { ...view, interrupted };
}

/** The transcript at the click: a reply mid-stream, then the turn 立即 drew under it. */
function clicked(over: SentNow["over"] = "run") {
  return {
    messages: [line("u1", "user", "first"), line("a1", "assistant", "half an ans"), ...optimisticQueuedTurn({ id: "q1", text: "next" })],
    sentNow: { conversationId: "chat", id: "q1", over, revision: 0 } as SentNow,
  };
}

test("what the stopped run still says lands above the turn 立即 drew, not in it", () => {
  // A tool is aborted mid-run: the loop closes its turn, opens one more, then ends.
  const stopping = play(clicked(), [
    delta("wer"),
    ev("turn_end"),
    ev("turn_start"),
    ev("agent_end", { messages: [aborted] }),
  ]);
  const [, old, prompt, reply] = stopping.messages;
  assert.equal(old.text, "half an answer", "the last delta belongs to the reply that was cut");
  assert.equal(old.stop, "aborted");
  assert.equal(prompt.id, "queue:q1");
  assert.equal(reply.text, "", "the new turn has not said anything yet");
  assert.equal(reply.stop, undefined, "and it was not interrupted");
  assert.equal(stopping.interrupted, undefined, "stopping for 立即 is not an interruption to resume from");

  const settled = play(stopping, [ev("agent_settled", { replaced: true })]);
  assert.equal(settled.streaming, true, "the turn on screen has not run yet");
  assert.equal(settled.sentNow?.over, null);

  const running = play(settled, [
    ev("agent_start"),
    ev("message_start", { message: { role: "user", content: [{ type: "text", text: "next" }] }, queueId: "q1" }),
    ev("user_message_persisted", { entryId: "entry-2" }),
    ev("message_start", { message: { role: "assistant", content: [] } }),
    delta("the new answer"),
  ]);
  assert.deepEqual(running.messages.map((message) => message.id), ["u1", "a1", "entry-2", "queue-reply:q1"]);
  assert.equal(running.messages[3].text, "the new answer");
  assert.equal(running.messages[1].text, "half an answer");
  assert.equal(running.sentNow, null, "the engine has the prompt now");
});

test("the chat going idle with the turn still unsent takes the turn back", () => {
  const after = play(clicked(null), [ev("conversation_running", { running: false })]);
  assert.deepEqual(after.messages.map((message) => message.id), ["u1", "a1"]);
  assert.equal(after.sentNow, null);
});

test("an echo for a different row means the engine is sending that one", () => {
  const other = { role: "user", content: [{ type: "text", text: "something else" }] };
  const after = play(clicked(null), [ev("agent_start"), ev("message_start", { message: other, queueId: "q9" })]);
  assert.equal(after.sentNow, null);
  assert.equal(after.messages.some((message) => message.id.startsWith("queue")), false);
  assert.equal(after.messages.filter((message) => message.role === "user").at(-1)?.text, "something else");
  // An engine that does not name the row (an older Agent on an SSH host) is not saying that.
  const unnamed = play(clicked(null), [ev("agent_start"), ev("message_start", { message: other })]);
  assert.equal(unnamed.sentNow?.id, "q1");
});

test("a run 立即 replaced is neither an interruption nor idle for a client that drew nothing", () => {
  const start = { messages: [line("u1", "user", "first"), line("a1", "assistant", "half")], sentNow: null };
  const after = play(start, [ev("agent_end", { messages: [aborted], replaced: true }), ev("agent_settled", { replaced: true })]);
  assert.equal(after.interrupted, undefined);
  assert.equal(after.streaming, true);
  const plain = play(start, [ev("agent_end", { messages: [aborted] }), ev("agent_settled")]);
  assert.equal(plain.interrupted, "aborted");
  assert.equal(plain.streaming, false);
});

test("a turn whose reply already has content is kept when it is taken back", () => {
  const [prompt, reply] = optimisticQueuedTurn({ id: "q1", text: "next" });
  const kept = retractOptimisticTurn([line("a1", "assistant", "old"), prompt, { ...reply, text: "started" }]);
  assert.deepEqual(kept.map((message) => message.id), ["a1", "local:q1", "queue-reply:q1"]);
  assert.deepEqual(retractOptimisticTurn([line("a1", "assistant", "old"), prompt, reply]).map((message) => message.id), ["a1"]);
});

test("a transcript read keeps the drawn turn in its own chat and nowhere else", () => {
  const shown = clicked().messages;
  const read = [line("u1", "user", "first"), line("a1", "assistant", "half an answer")];
  assert.equal(preserveOptimisticTail(shown, read, true).length, 4);
  assert.equal(preserveOptimisticTail(shown, [line("b1", "user", "another chat")], false).length, 1);
});

test("a transcript read that already holds the sent turn does not draw it twice", () => {
  const shown = [line("k1", "user", "first"), line("k2", "assistant", ""), ...optimisticQueuedTurn({ id: "q1", text: "next" })];
  // The stopped run's settle triggers a read; by then the next prompt is persisted.
  const read = [line("k1", "user", "first"), line("k2", "assistant", ""), line("e9", "user", "next"), line("running:1", "assistant", "")];
  const merged = preserveOptimisticTail(shown, read, true);
  assert.deepEqual(merged.map((message) => message.id), ["k1", "k2", "queue:q1", "queue-reply:q1"]);
  // An older identical prompt already on screen is not mistaken for the new one.
  const again = [line("u0", "user", "next"), line("a0", "assistant", "ok"), ...optimisticQueuedTurn({ id: "q2", text: "next" })];
  const readAgain = [line("u0", "user", "next"), line("a0", "assistant", "ok")];
  assert.deepEqual(preserveOptimisticTail(again, readAgain, true).map((message) => message.id), ["u0", "a0", "queue:q2", "queue-reply:q2"]);
});

test("the entry id of a turn the transcript already holds never lands on two rows", () => {
  const rows = [line("e9", "user", "next"), line("local:x", "user", "next")];
  const next = exports.applyEngineEvent!(rows, { type: "user_message_persisted", entryId: "e9" } as EngineEvent, true).messages;
  assert.deepEqual(next.map((message) => message.id), ["e9"]);
});
