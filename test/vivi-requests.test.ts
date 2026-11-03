import assert from "node:assert/strict";
import { test } from "node:test";
import { createPendingUiRefresh, reconcilePendingUi } from "../src/renderer/src/lib/pending-ui.ts";
import { collectViviRequests } from "../src/renderer/src/lib/vivi-requests.ts";
import type { BotAttention, BotConversationMeta } from "../src/shared/bot.ts";
import type { EngineEvent, PermissionRequest } from "../src/shared/types.ts";

const request = (id: string, conversationId = "worker-a", method: PermissionRequest["method"] = "confirm"): EngineEvent => ({ type: "extension_ui_request", id, conversationId, method, title: id, seq: 1 });
const dismiss = (id: string, conversationId = "worker-a"): EngineEvent => ({ type: "extension_ui_dismiss", id, conversationId, seq: 2 });
const meta = (id: string): BotConversationMeta => ({ conversationId: id, role: id === "router" ? "router" : "worker", owner: "vivi", creationKey: id, epoch: 2, paused: false, createdAt: 1, updatedAt: 1, title: `Work ${id}` });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("存量快照重放读取期间的request/dismiss，不复活已撤回问题，也不丢新问题", () => {
  const pending = reconcilePendingUi([request("old"), request("kept")], [dismiss("old"), request("new", "worker-b"), request("kept")]);
  assert.deepEqual(pending.map((item) => [item.id, item.conversationId]), [["kept", "worker-a"], ["new", "worker-b"]]);
  assert.deepEqual(reconcilePendingUi([], [request("short-lived"), dismiss("short-lived")]), []);
  assert.deepEqual(reconcilePendingUi([request("local")], [dismiss("local", "another-conversation")]).map((item) => item.id), ["local"]);
});

test("本地与远端水位不比较，原始命名空间与多问题、编辑内容完整保留", () => {
  const remote = { ...request("remote:host:prompt", "remote:host:worker", "editor"), prefill: "Line 1\nLine 2", seq: 800 };
  const questions = { ...request("multi", "worker-b", "questions"), questions: [{ question: "选择？", options: ["A", "B"], allowOther: true }] };
  const pending = reconcilePendingUi([remote], [{ ...dismiss("remote:host:prompt", "remote:host:worker"), seq: 3 }, questions]);
  assert.deepEqual(pending.map((item) => item.id), ["multi"]);
  assert.deepEqual(pending[0].questions, [{ question: "选择？", header: undefined, options: ["A", "B"], optionDetails: undefined, allowOther: true }]);
  assert.equal(reconcilePendingUi([remote], [])[0].prefill, "Line 1\nLine 2");
});

test("读取先订阅，并发读取合并，一次性提交重放后的队列且卸载临时订阅", async () => {
  const read = deferred<Array<Record<string, unknown>>>();
  let listener: ((event: EngineEvent) => void) | undefined;
  let subscribed = false;
  let reads = 0;
  let offCount = 0;
  const adopted: PermissionRequest[][] = [];
  const refresh = createPendingUiRefresh({
    subscribe: (value) => { subscribed = true; listener = value; return () => { offCount++; }; },
    read: () => { assert.equal(subscribed, true); reads++; return read.promise; },
    adopt: (value) => adopted.push(value),
  });
  const first = refresh(); const second = refresh();
  assert.equal(first, second);
  listener!(dismiss("old")); listener!(request("after-read", "worker-b"));
  read.resolve([request("old")]);
  await first;
  assert.equal(reads, 1);
  assert.equal(adopted.length, 1);
  assert.deepEqual(adopted[0].map((item) => item.id), ["after-read"]);
  assert.equal(offCount, 1);
});

test("读取失败不清空实时队列，释放订阅后允许重试", async () => {
  let tries = 0;
  let cleanup = 0;
  let adopted = 0;
  const refresh = createPendingUiRefresh({
    subscribe: () => () => { cleanup++; },
    read: async () => { if (++tries === 1) throw new Error("offline"); return [request("retry")]; },
    adopt: () => { adopted++; },
  });
  await assert.rejects(refresh(), /offline/);
  assert.equal(adopted, 0);
  await refresh();
  assert.equal(adopted, 1); assert.equal(cleanup, 2);
});

test("Vivi统一列表只收所属Router/Worker，保留原id和问题来源并排除过期attention", () => {
  const question: BotAttention = { id: "q", conversationId: "worker-b", epoch: 2, question: "受众？", status: "pending", createdAt: 3 };
  const pending = reconcilePendingUi([request("a"), request("b", "worker-b", "input"), request("other", "normal"), request("router-prompt", "router", "select"), request("a")], []);
  const grouped: Record<string, PermissionRequest[]> = {};
  for (const item of pending) (grouped[item.conversationId!] ??= []).push(item);
  const rows = collectViviRequests([meta("router"), meta("worker-a"), meta("worker-b")], [question, { ...question, id: "old", epoch: 1 }, { ...question, id: "resolved", status: "resolved" }, question], grouped);
  assert.deepEqual(rows.map((item) => [item.kind, item.key, item.conversationId]), [
    ["plugin", "plugin:a", "worker-a"], ["plugin", "plugin:b", "worker-b"], ["plugin", "plugin:router-prompt", "router"], ["question", "question:q", "worker-b"],
  ]);
  assert.equal(rows[0].title, "Work worker-a");
  const first = rows[0]; assert.equal(first.kind, "plugin");
  if (first.kind === "plugin") assert.equal(first.request.id, "a");
  assert.deepEqual(collectViviRequests([], [question], grouped), []);
});

test("只接收阻塞交互方法，notify/status/widget不成为待处理项", () => {
  const events = ["confirm", "select", "input", "editor", "questions", "notify", "setStatus", "setWidget", "custom"].map((method) => ({ ...request(method), method }));
  assert.deepEqual(reconcilePendingUi(events, []).map((item) => item.method), ["confirm", "select", "input", "editor", "questions"]);
});
