import assert from "node:assert/strict";
import test from "node:test";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { mapLegacyReplayCommand, projectLegacyWorkSnapshot } from "../src/main/bot/shadow/legacy-compat.ts";
import type { Decision, Thread, Ticket, Trigger } from "../src/main/bot/core/model.ts";

const at = "2026-01-01T00:00:00.000Z";
const thread: Thread = { key: "local:chat", ref: { source: "local", id: "chat" }, createdAt: at, lastAt: at, subscriptions: [], correlated: [], pending: [], meta: {} };
const trigger: Trigger = { id: "trigger-1", source: "local", threads: [thread.ref], actor: { source: "local", id: "person" }, human: true, addressed: "direct", at, text: "请处理", meta: {} };
const mandate = { strength: "explicit" as const, policyVersion: "test", basis: { via: "addressed" as const, addressed: "direct" as const }, actor: trigger.actor, scope: "local" };
const ticket: Ticket = {
  id: "ticket-1", title: "工作", decisionId: "decision-1", mandate,
  channels: [], assignments: [{ id: "assignment-1", state: "running", createdAt: at, startedAt: at, report: { state: "ready", summary: "产物已准备", at }, deliveredAt: at }],
  inputs: [{ id: "input-1", kind: "trigger", triggerId: trigger.id, at, human: true, deliveredTo: "assignment-1", deliveredAt: at, readAt: at }],
  undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
};
const decision: Decision = { id: "decision-1", evalId: "eval-1", threadKey: "local:chat", triggerIds: [trigger.id], policyVersion: "test", at, kind: "accept", reason: [], strength: "explicit", ticketId: ticket.id, mandate };


test("Shadow projection is read-only and keeps ready, delivery, read, and report separate", () => {
  const store = openShadowStore();
  try {
    store.threads.save(thread); store.triggers.save(trigger); store.decisions.save(decision); store.tickets.save(ticket);
    store.receipts.add({ id: "delivery-1", channel: { source: "local", thread: "chat", address: {} }, text: "已收到", kind: "acknowledgement", ticketId: ticket.id });
    const before = store.db.countRows("vivi_outbox");
    const snapshot = projectLegacyWorkSnapshot(store, Date.parse(at));
    assert.equal(snapshot.results[0]?.status, "ready");
    assert.notEqual(snapshot.results[0]?.status, "completed");
    assert.equal(snapshot.deliveries[0]?.status, "pending");
    assert.deepEqual(snapshot.shadow.inputs[0], { inputId: "input-1", ticketId: "ticket-1", assignmentId: "assignment-1", deliveredAt: at, readAt: at });
    assert.equal(snapshot.shadow.inputs[0]?.reportedAt, undefined);
    assert.equal(snapshot.results[0]?.createdAt, Date.parse(at));
    assert.equal(snapshot.shadow.deliveries[0]?.status, "pending");
    assert.equal(store.db.countRows("vivi_outbox"), before);
    assert.equal(store.db.countRows("bot_outbox"), 0);
  } finally { store.close(); }
});

test("replay mapping is stable, controlled, and never writes legacy tables", () => {
  const first = mapLegacyReplayCommand({ action: "submit", requestId: "req-1", text: "做事" });
  const second = mapLegacyReplayCommand({ action: "submit", requestId: "req-1", text: "做事" });
  assert.deepEqual(first, second); assert.equal(first.status, "mapped");
  if (first.status === "mapped") { assert.equal(first.command.kind, "local.receive"); assert.equal(first.command.trigger.source, "local"); }
  const report = mapLegacyReplayCommand({ action: "report", requestId: "r", conversationId: "ticket-1", summary: "完成", outcome: "ready" });
  assert.equal(report.status, "mapped");
  if (report.status === "mapped") assert.equal(report.command.kind, "local.report");
  const refused = mapLegacyReplayCommand({ action: "writeLegacyTable", table: "bot_results", row: {} });
  assert.equal(refused.status, "unsupported"); assert.match(refused.reason, /旧表/);
});

test("continue, stop, and answer map to explicit Shadow controls", () => {
  assert.equal(mapLegacyReplayCommand({ action: "stop", conversationId: "ticket-1" }).status, "mapped");
  assert.equal(mapLegacyReplayCommand({ action: "continue", conversationId: "ticket-1", inputId: "input-1" }).status, "mapped");
  const answer = mapLegacyReplayCommand({ action: "answer", attentionId: "attention-1", answer: "继续" });
  assert.equal(answer.status, "mapped");
  if (answer.status === "mapped") assert.equal(answer.command.kind, "main.reply");
});
