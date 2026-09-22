import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultNotificationSettings,
  isBlockingPrompt,
  notificationEnabled,
  notificationForEvent,
} from "../src/shared/notifications.ts";

/**
 * 系统通知 decides two things independently of Electron, and both are the kind of thing
 * that fails quietly: which switch an event belongs to, and whether a scenario is on for
 * an install whose `settings.json` predates the switches.
 */

test("an absent preference means on, so an upgraded install is not silently muted", () => {
  for (const setting of Object.keys(defaultNotificationSettings())) {
    assert.equal(notificationEnabled({}, setting), true, setting);
  }
});

test("only an explicit false silences a scenario", () => {
  assert.equal(notificationEnabled({ notifyDone: false }, "notifyDone"), false);
  // A malformed value is not a "no" — the renderer drops it and reads back the default.
  assert.equal(notificationEnabled({ notifyDone: "nope" }, "notifyDone"), true);
  // And one switch never silences another.
  assert.equal(notificationEnabled({ notifyDone: false }, "notifyError"), true);
});

test("a fresh install notifies about every scenario", () => {
  assert.deepEqual(defaultNotificationSettings(), {
    notifyDone: true,
    notifyError: true,
    notifyApproval: true,
    notifyUpdate: true,
  });
});

test("a settled run maps to completed or failed, and carries its conversation", () => {
  const completed = notificationForEvent({
    type: "conversation_activity",
    status: "completed",
    conversationId: "c1",
    title: "修复登录",
  });
  assert.deepEqual(completed, { setting: "notifyDone", title: "修复登录", conversationId: "c1" });

  const failed = notificationForEvent({ type: "conversation_activity", status: "failed", conversationId: "c2" });
  assert.equal(failed?.setting, "notifyError");
  assert.equal(failed?.conversationId, "c2");
});

test("a blocking prompt notifies and points at its chat; a one-way one does not", () => {
  for (const method of ["confirm", "select", "input", "editor", "questions"]) {
    assert.equal(isBlockingPrompt({ method }), true, method);
    assert.equal(notificationForEvent({ type: "extension_ui_request", method, conversationId: "c1" })?.setting, "notifyApproval", method);
  }
  // `notify` / `setStatus` / `setWidget` are fire-and-forget: interrupting the user for
  // one would be a notice about nothing the user has to do.
  for (const method of ["notify", "setStatus", "setWidget", "set_editor_text", "setTitle"]) {
    assert.equal(notificationForEvent({ type: "extension_ui_request", method }), null, method);
  }
});

test("the events that arrive constantly raise nothing", () => {
  // This is the gate the stream passes through once per token, so a shape it actually
  // has must not be mistaken for a notice.
  for (const type of ["message_update", "message_start", "turn_start", "turn_end", "conversation_running", "tool_execution_end", "subagent_event", "queue_changed"]) {
    assert.equal(notificationForEvent({ type }), null, type);
  }
});
