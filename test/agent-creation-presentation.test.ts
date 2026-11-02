import { test } from "node:test";
import assert from "node:assert/strict";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { conversationAgents } from "../src/renderer/src/lib/conversation-resources.ts";
import { familyOf } from "../src/renderer/src/lib/tool-family.ts";
import { agentThreadIdForRun, findSubagentForThread, subagentToolRuns } from "../src/shared/subagent-state.ts";
import type { AgentThread } from "../src/shared/agent-thread.ts";
import type { SubagentInfo, ToolCallBlock } from "../src/shared/types.ts";

const thread: AgentThread = {
  id: "agent-one", conversationId: "chat", rootId: "agent-one", taskName: "sdk-tests", agent: "worker",
  name: "Warm Seal", avatarSeed: 42, task: "Add real SDK integration tests", cwd: "/workspace",
  status: "working", currentTurn: 1, createdAt: 1, updatedAt: 2, revision: 2,
};
const tool: ToolCallBlock = {
  id: "spawn-call", name: "spawn_agent", status: "done",
  args: { task_name: "sdk-tests", message: thread.task }, details: { thread },
};
const info = (over: Partial<SubagentInfo> = {}): SubagentInfo => ({
  id: `${thread.id}:turn:1`, conversationId: "chat", name: thread.name, avatarSeed: thread.avatarSeed,
  status: "running", phase: "working", ...over,
});
const messages = [{ id: "reply", role: "assistant" as const, text: "", tools: [tool], createdAt: 1 }];

test("persisted spawn results restore the creation action and thread identity", () => {
  const restored = mapEngineMessages([
    { role: "assistant", content: [{ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args }] },
    { role: "toolResult", toolCallId: tool.id, content: [{ type: "text", text: "created" }], details: tool.details },
  ]);
  const creation = restored[0].tools[0];
  assert.equal(familyOf(creation.name), "agent");
  assert.deepEqual(restored[0].parts, [{ kind: "tool", toolId: tool.id }]);
  assert.deepEqual(subagentToolRuns(creation), [{ id: thread.id, agent: "worker", name: "Warm Seal", task: thread.task, avatarSeed: 42, parentId: undefined, status: "running" }]);
});

test("creation history, live turns and persisted threads are one resource row", () => {
  const agents = conversationAgents("chat", messages, [info(), info({ conversationId: "other" })], [thread]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, thread.id);
  assert.equal(agents[0].avatarSeed, 42);
  assert.equal(agents[0].name, "Warm Seal");
  assert.equal(agents[0].brief, thread.task);
  assert.equal(agents[0].status, "running");
});

test("the latest follow-up turn wins regardless of registry order", () => {
  const second = info({ id: `${thread.id}:turn:2`, status: "running", detail: "Follow up" });
  const first = info({ status: "completed" });
  for (const registry of [[first, second], [second, first]]) {
    assert.equal(findSubagentForThread(registry, thread.id, "chat"), second);
    const agents = conversationAgents("chat", messages, registry, [{ ...thread, status: "completed" }]);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].status, "running");
    assert.equal(agents[0].brief, "Follow up");
  }
});

test("recovery status supersedes the creation-time running snapshot", () => {
  const recovered = { ...thread, status: "interrupted" as const, revision: 3 };
  assert.equal(conversationAgents("chat", messages, [], [recovered])[0].status, "interrupted");
  const stale = conversationAgents("chat", messages, [info()], [recovered])[0];
  assert.equal(stale.info?.status, "interrupted");
  assert.equal(stale.info?.phase, undefined);
});

test("legacy delegations keep their tool-call run id, and failed spawns invent no thread", () => {
  assert.equal(agentThreadIdForRun("legacy:0"), "legacy:0");
  assert.deepEqual(subagentToolRuns({ id: "legacy", name: "subagent", status: "done", args: { agent: "worker", task: "Build" }, details: { results: [{ exitCode: 0 }] } }), [
    { id: "legacy:0", agent: "worker", name: "worker", task: "Build", status: "completed" },
  ]);
  assert.deepEqual(subagentToolRuns({ ...tool, status: "error", details: undefined }), []);
});
