import { test } from "node:test";
import assert from "node:assert/strict";
import { mobileNoticeForEvent, notificationTarget } from "../apps/mobile/src/notifications/policy.ts";

const context = {
  background: true,
  enabled: true,
  serverId: "server",
  conversations: [{ id: "c" }, { id: "side", kind: "side-chat" }, { id: "ssh:server:c" }],
  archivedIds: [],
  permissionAlways: [],
};

const notice = (event: Record<string, unknown>, extra: Partial<typeof context> = {}) =>
  mobileNoticeForEvent(event, { ...context, ...extra });

test("notifications require an enabled background app", () => {
  assert.equal(notice({ type: "conversation_activity", conversationId: "c", status: "completed" }, { background: false }), null);
  assert.equal(notice({ type: "conversation_activity", conversationId: "c", status: "completed" }, { enabled: false }), null);
});

test("activity completed and failed notifications are keyed by server, chat and seq", () => {
  assert.deepEqual(notice({ type: "conversation_activity", conversationId: "c", status: "completed", title: "完成", seq: 4 }), {
    kind: "done", conversationId: "c", title: "完成", key: JSON.stringify(["server", "c", 4]),
  });
  assert.deepEqual(notice({ type: "conversation_activity", conversationId: "c", status: "failed", seq: Infinity }), {
    kind: "error", conversationId: "c",
  });
  assert.equal(notice({ type: "conversation_activity", conversationId: "c", status: "stopped" }), null);
  assert.equal(notice({ type: "conversation_activity", conversationId: "c", status: "retry" }), null);
  assert.deepEqual(notice({ type: "conversation_activity", conversationId: "c", status: "completed", seq: "4" }), {
    kind: "done", conversationId: "c",
  });
  assert.equal(notice({ type: "compaction_end", conversationId: "c" }), null);
  assert.equal(notice({ type: "agent_end", conversationId: "c" }), null);
});

test("all blocking requests notify, while remembered confirms do not", () => {
  for (const method of ["confirm", "select", "input", "editor", "questions", "plan_review"]) {
    const result = notice({ type: "extension_ui_request", conversationId: "c", id: method, method });
    assert.deepEqual(result, { kind: "approval", conversationId: "c", key: JSON.stringify(["server", method]) });
  }
  assert.equal(notice({ type: "extension_ui_request", conversationId: "c", id: "x", method: "confirm", title: "Run", message: "npm test" }, {
    permissionAlways: ["confirm:Run:npm test"],
  }), null);
  assert.equal(notice({ type: "extension_ui_request", conversationId: "c", id: "x", method: "notify" }), null);
  assert.deepEqual(notice({ type: "extension_ui_request", conversationId: "c", id: "x", method: "confirm" }), {
    kind: "approval", conversationId: "c", key: JSON.stringify(["server", "x"]),
  });
});

test("unknown, archived, side-chat and malformed conversation ids are ignored", () => {
  assert.equal(notice({ type: "conversation_activity", conversationId: "unknown", status: "completed" }), null);
  assert.equal(notice({ type: "conversation_activity", conversationId: "side", status: "completed" }), null);
  assert.equal(notice({ type: "conversation_activity", conversationId: "c", status: "completed" }, { archivedIds: ["c"] }), null);
  assert.equal(notice({ type: "conversation_activity", conversationId: "", status: "completed" }), null);
  assert.equal(notice({ type: "conversation_activity", conversationId: "ssh:server:c", status: "completed" })?.conversationId, "ssh:server:c");
  assert.notEqual(notice({ type: "conversation_activity", conversationId: "c", status: "completed", seq: 1 }, { serverId: "a:b" })?.key,
    JSON.stringify(["a", "b:c", 1]));
});

test("notification targets accept only fastvibe chat objects", () => {
  assert.deepEqual(notificationTarget({ type: "fastvibe.chat", serverId: "s", conversationId: "c" }), { serverId: "s", conversationId: "c" });
  for (const value of [null, [], {}, { type: "other", serverId: "s", conversationId: "c" }, { type: "fastvibe.chat", serverId: "", conversationId: "c" }, { type: "fastvibe.chat", serverId: "s", conversationId: 1 }]) {
    assert.equal(notificationTarget(value), null);
  }
});
