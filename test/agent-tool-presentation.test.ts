import { test } from "node:test";
import assert from "node:assert/strict";
import { agentToolAction, agentToolTargets } from "../src/renderer/src/lib/agent-tool.ts";
import { familyOf } from "../src/renderer/src/lib/tool-family.ts";
import { foldsIntoRun } from "../src/renderer/src/lib/tool-run.ts";
import type { ChatMessage, ToolCallBlock } from "../src/shared/types.ts";

const spawn: ToolCallBlock = { id: "spawn", name: "spawn_agent", status: "done", details: { thread: { id: "agent-one", name: "Warm Seal", avatarSeed: 42 } } };
const wait: ToolCallBlock = { id: "wait", name: "wait_agent", status: "running", args: { targets: ["agent-one"] } };
const messages: ChatMessage[] = [{ id: "reply", role: "assistant", text: "", tools: [spawn, wait], createdAt: 1 }];

test("only team checks can join a batch; running waits and team changes stay standalone", () => {
  for (const name of ["spawn_agent", "wait_agent", "send_message", "followup_task", "interrupt_agent", "list_agents"]) {
    assert.ok(agentToolAction(name));
    assert.equal(familyOf(name), "agent");
    assert.equal(foldsIntoRun(name), name === "list_agents");
  }
  assert.equal(agentToolAction("unknown"), undefined);
});

test("a running wait restores clickable identity from persisted creation history", () => {
  const [target] = agentToolTargets(wait, "chat", messages, []);
  assert.equal(target.id, "agent-one");
  assert.equal(target.name, "Warm Seal");
  assert.equal(target.avatarSeed, 42);
});

test("target order and deduplication survive missing identities and a cross-chat registry", () => {
  const targets = agentToolTargets({ ...wait, args: { targets: ["missing", "agent-one", "missing"] } }, "chat", messages, [
    { id: "agent-one:turn:1", conversationId: "other", name: "Wrong chat", avatarSeed: 99, status: "running" },
  ]);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], { id: "missing" });
  assert.equal(targets[1].name, "Warm Seal");
});

test("persisted results resolve identities without a live registry or creation messages", () => {
  const details = { threads: [{ id: "agent-one", name: "Warm Seal", avatarSeed: 42 }] };
  assert.deepEqual(agentToolTargets({ ...wait, args: {}, details }, "chat", [], []), details.threads);
  assert.deepEqual(agentToolTargets({ ...wait, name: "followup_task", args: { target: "agent-one" }, details: { result: details.threads[0] } }, "chat", [], []), details.threads);
});

test("an implicit wait excludes later creations and respects an empty persisted result", () => {
  const later = { ...spawn, id: "later", details: { thread: { id: "agent-later", name: "Later" } } };
  const history = [{ ...messages[0], tools: [spawn, wait, later] }];
  assert.deepEqual(agentToolTargets({ ...wait, args: {} }, "chat", history, []).map((item) => item.id), ["agent-one"]);
  assert.deepEqual(agentToolTargets({ ...wait, args: {}, details: { threads: [] } }, "chat", history, []), []);
  assert.deepEqual(agentToolTargets({ ...wait, args: {} }, "chat", [], [
    { id: "T-0001", conversationId: "chat", name: "DAG worker", status: "running" },
    { id: "agent-one:turn:1", conversationId: "chat", name: "Warm Seal", avatarSeed: 42, status: "running" },
  ]), [{ id: "agent-one", name: "Warm Seal", avatarSeed: 42 }]);
});
