import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationAgents } from "../src/renderer/src/lib/conversation-resources.ts";
import { todoSnapshot } from "../src/renderer/src/lib/todos.ts";
import type { ChatMessage, SubagentInfo, ToolCallBlock } from "../src/shared/types.ts";

const message = (id: string, tools: ToolCallBlock[]): ChatMessage => ({ id, role: "assistant", text: "", tools, createdAt: 1 });

test("resource subagents use their owning conversation and live status over persisted outcomes", () => {
  const messages = [message("reply", [{ id: "delegate", name: "subagent", status: "done", args: { tasks: [{ agent: "worker", task: "build" }, { agent: "reviewer", task: "review" }] }, details: { results: [{ exitCode: 0 }, { exitCode: 0 }] } }])];
  const registry: SubagentInfo[] = [
    { id: "delegate:0", conversationId: "a", name: "worker", status: "running", phase: "waiting" },
    { id: "delegate:0", conversationId: "b", name: "other host", status: "error" },
    { id: "unrelated", conversationId: "b", status: "running" },
  ];
  const agents = conversationAgents("a", messages, registry);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].name, "worker");
  assert.equal(agents[0].brief, "build");
  assert.equal(agents[0].status, "running");
  assert.equal(agents[0].info?.phase, "waiting");
  assert.equal(agents[1].status, "completed");
});

test("a failed sibling never makes a successful sibling fail after restart", () => {
  const agents = conversationAgents("a", [message("reply", [{ id: "tool", name: "subagent", status: "error", args: { chain: [{ agent: "one" }, { agent: "two" }] }, details: { results: [{ exitCode: 0 }, { exitCode: 1, stopReason: "error" }] } }])], []);
  assert.equal(agents.find((agent) => agent.name === "one")?.status, "completed");
  assert.equal(agents[0].name, "two");
  assert.equal(agents[0].status, "error");
});

test("resource todo links to the latest settled list and marks an earlier plan", () => {
  const messages = [message("plan", [{ id: "todo", name: "todo", status: "done", args: { todos: [{ content: "Build", status: "completed" }] } }]), { ...message("next", []), role: "user" as const }];
  assert.equal(todoSnapshot(messages).entryId, "plan");
  assert.equal(todoSnapshot(messages).superseded, true);
});
