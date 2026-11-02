import assert from "node:assert/strict";
import test from "node:test";
import { completedViviReply, ViviCompletionState } from "../src/renderer/src/lib/vivi-completion.ts";
import type { ChatMessage } from "../src/shared/types.ts";

const message = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: "m",
  role: "assistant",
  text: "",
  tools: [],
  createdAt: 1,
  ...patch,
});

test("returns only the persisted successful assistant answer", () => {
  assert.equal(completedViviReply([
    message({ role: "user", text: "帮我做事" }),
    message({ text: "中间回复", completedAt: 2 }),
    message({ text: "最终完成", completedAt: 3 }),
  ]), "最终完成");
});

test("does not narrate errors, stopped turns, partial turns, or tool-only work", () => {
  assert.equal(completedViviReply([
    message({ role: "user", text: "任务" }),
    message({ text: "失败了", error: "503", completedAt: 2 }),
  ]), "");
  assert.equal(completedViviReply([
    message({ role: "user", text: "任务" }),
    message({ text: "被中断", stop: "aborted", completedAt: 2 }),
  ]), "");
  assert.equal(completedViviReply([
    message({ role: "user", text: "任务" }),
    message({ id: "running:chat", text: "还在流式" }),
  ]), "");
});

test("does not cross an earlier user turn to show stale content", () => {
  assert.equal(completedViviReply([
    message({ role: "assistant", text: "旧答案", completedAt: 1 }),
    message({ role: "user", text: "新问题" }),
  ]), "");
});

test("a failed or tool-only last request cannot fall back to intermediate prose", () => {
  const progress = message({ text: "正在检查", completedAt: 2 });
  for (const ending of [
    message({ text: "失败", error: "503" }),
    message({ text: "截断", stop: "length" }),
    message({ text: "", completedAt: 3 }),
    message({ text: "运行工具", tools: [{ id: "t", name: "read", status: "done" }] as ChatMessage["tools"] }),
  ]) assert.equal(completedViviReply([progress, ending]), "");
});

const completed = (conversationId: string) => ({ type: "conversation_activity", status: "completed", conversationId });
const snapshot = (conversationId: string, text = "最终结果", running = false) => ({ conversationId, running, messages: [message({ text, completedAt: 3 })] });

test("only successful completion events request a transcript", () => {
  const state = new ViviCompletionState();
  for (const event of [
    { type: "message_update", conversationId: "a" },
    { type: "tool_execution_start", conversationId: "a" },
    { type: "extension_ui_request", conversationId: "a" },
    { type: "conversation_activity", conversationId: "a", status: "failed" },
    { type: "conversation_running", conversationId: "a", running: false },
  ]) assert.equal(state.event(event), undefined);
  const request = state.event(completed("a"))!;
  assert.ok(state.accept(request, snapshot("a")));
  assert.equal(state.completion?.conversationId, "a");
  assert.equal(state.completion?.text, "最终结果");
});

test("a newer completion wins even if the older conversation's read finishes later", () => {
  const state = new ViviCompletionState();
  const a = state.event(completed("a"))!;
  const b = state.event(completed("b"))!;
  assert.equal(state.accept(b, snapshot("b", "B 完成")), true);
  assert.equal(state.accept(a, snapshot("a", "A 完成")), false);
  assert.deepEqual(state.completion, { conversationId: "b", text: "B 完成", revision: b.revision });
});

test("restarting a conversation invalidates pending reads and its displayed completion", () => {
  const state = new ViviCompletionState();
  const old = state.event(completed("a"))!;
  state.event({ type: "conversation_running", conversationId: "a", running: true });
  assert.equal(state.accept(old, snapshot("a")), false);
  const next = state.event(completed("a"))!;
  assert.equal(state.accept(next, snapshot("a")), true);
  state.event({ type: "agent_start", conversationId: "a" });
  assert.equal(state.completion, undefined);
});

test("snapshots from a running or different conversation cannot supply a completion", () => {
  const state = new ViviCompletionState();
  const request = state.event(completed("a"))!;
  assert.equal(state.accept(request, snapshot("a", "中间内容", true)), false);
  assert.equal(state.accept(request, snapshot("b")), false);
  assert.equal(state.completion, undefined);
});
