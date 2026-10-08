import assert from "node:assert/strict";
import test from "node:test";
import { findSubagent, mergeSubagentSnapshot, reduceSubagent, subagentFinished, subagentKey, subagentResultStatus, subagentViewStatus, upsertSubagent } from "../src/shared/subagent-state.ts";
import type { SubagentInfo, ToolCallBlock } from "../src/shared/types.ts";

const event = (seq: number, extra: Record<string, unknown> = {}) => ({
  type: "subagent_lifecycle", subagentId: "call:0", conversationId: "chat-a", status: "running", seq, ...extra,
});
const start = () => reduceSubagent(undefined, event(1), 100)!;

test("same DAG run ids on local and remote engines retain independent lifecycle and snapshot state", () => {
  const local = "chat-a";
  const remote = "remote:server-a:chat-a";
  const remoteB = "remote:server-b:chat-a";
  const runId = "T-0001";
  let list = upsertSubagent([], event(100, { subagentId: runId, conversationId: local, status: "completed" }));
  list = upsertSubagent(list, event(1, { subagentId: runId, conversationId: remote }));
  list = mergeSubagentSnapshot(list, [{ id: runId, conversationId: remoteB, status: "running", revision: 2 }]);
  assert.equal(list.length, 3);
  assert.equal(findSubagent(list, runId, local)?.status, "completed");
  assert.equal(findSubagent(list, runId, remote)?.status, "running");
  assert.equal(findSubagent(list, runId, remoteB)?.status, "running");
  assert.equal(findSubagent(list, runId), undefined, "an ownerless lookup cannot guess a host");
  list = upsertSubagent(list, event(3, { subagentId: runId, conversationId: remote, status: "aborted" }));
  const stale = mergeSubagentSnapshot(list, [{ id: runId, conversationId: remote, status: "running", revision: 1 }]);
  assert.equal(stale, list);
  assert.equal(findSubagent(list, runId, remoteB)?.status, "running");
  assert.equal(new Set([local, remote, remoteB].map((owner) => subagentKey(runId, owner))).size, 3);
});

test("a background lifecycle owns its conversation without any parent tool_start", () => {
  assert.equal(start().conversationId, "chat-a");
});

test("scoped/empty snapshots cannot delete another conversation's running records", () => {
  const current = [start()];
  assert.equal(mergeSubagentSnapshot(current, []), current);
  const merged = mergeSubagentSnapshot(current, [{ id: "b:0", conversationId: "chat-b", status: "running", revision: 2 }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], current[0]);
});

test("late snapshots and events cannot roll back terminal status or drop composer metadata", () => {
  const model = { provider: "test", id: "model", name: "Model" };
  const contextUsage = { contextWindow: 10000, tokens: 1200, percent: 12 };
  const state = reduceSubagent(start(), event(2, { type: "subagent_state", model, thinkingLevel: "high", contextUsage }))!;
  const stopped = reduceSubagent(state, event(3, { status: "aborted", error: "Stopped" }), 200)!;
  const current = [stopped];
  assert.equal(mergeSubagentSnapshot(current, [state]), current);
  assert.equal(reduceSubagent(stopped, event(1)), stopped);
  assert.equal(reduceSubagent(stopped, event(4)), stopped);
  assert.equal(stopped.model, model);
  assert.equal(stopped.thinkingLevel, "high");
  assert.equal(stopped.contextUsage, contextUsage);
  assert.equal(stopped.endedAt, 200);
});

test("metadata-only snapshots are adopted even when name and status have not changed", () => {
  const old = start();
  const newer = { ...old, revision: 2, thinkingLevel: "high" };
  assert.equal(mergeSubagentSnapshot([old], [newer])[0].thinkingLevel, "high");
});

test("agent_end/retry/compaction/settled cannot finalise before the runner caches its transcript", () => {
  let state = start();
  for (const [i, type] of ["agent_end", "auto_retry_start", "compaction_start", "agent_start", "agent_settled"].entries()) {
    state = reduceSubagent(state, event(i + 2, { type: "subagent_event", event: { type } }))!;
    assert.equal(state.status, "running");
    assert.equal(state.endedAt, undefined);
    assert.equal(subagentFinished(state.status), false);
    if (type === "auto_retry_start") assert.equal(state.phase, "retrying");
    if (type === "compaction_start") assert.equal(state.phase, "compacting");
  }
  state = reduceSubagent(state, event(10, { status: "error" }))!;
  assert.equal(subagentFinished(state.status), true);
});

test("approval wait survives unrelated stream activity until the owner releases it", () => {
  const waiting = reduceSubagent(start(), event(2, { type: "subagent_progress", phase: "waiting" }))!;
  assert.equal(reduceSubagent(waiting, event(3, { type: "subagent_event", event: { type: "message_start" } })), waiting);
  assert.equal(reduceSubagent(waiting, event(4, { type: "subagent_progress", phase: "working" }))!.phase, "working");
});

test("tab and composer use the same verdict; missing state is not 'completed'", () => {
  assert.equal(subagentViewStatus(undefined, "running"), "running");
  assert.equal(subagentViewStatus(undefined), "unknown");
  assert.equal(subagentFinished(subagentViewStatus(undefined)), false);
  assert.equal(subagentViewStatus({ ...start(), status: "aborted" }, "running"), "aborted");
});

test("aggregate tool completion cannot overwrite individual sibling outcomes", () => {
  const info = reduceSubagent(start(), event(2, { status: "aborted" }))!;
  assert.equal(reduceSubagent(info, { type: "tool_execution_end", toolName: "subagent", toolCallId: "call", isError: false }), info);
  const tool = { id: "call", name: "subagent", status: "error", details: { results: [
    { exitCode: 0 }, { exitCode: 1, stopReason: "aborted" }, { exitCode: 1, stopReason: "error" },
  ] } } as ToolCallBlock;
  assert.deepEqual([0, 1, 2, 3].map((i) => subagentResultStatus(tool, i)), ["completed", "aborted", "error", "skipped"]);
  assert.equal(subagentResultStatus({ ...tool, status: "running" }, 3), "queued");
});
