import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessagePart, ToolCallBlock } from "../src/shared/types.ts";
import { collapseToolRuns, foldsIntoRun, liveTool, runSummary } from "../src/renderer/src/lib/tool-run.ts";

function tool(id: string, name: string, status: ToolCallBlock["status"] = "done"): ToolCallBlock {
  return { id, name, status };
}

function partsOf(...items: Array<MessagePart | ToolCallBlock>): MessagePart[] {
  return items.map((item) => ("status" in item ? { kind: "tool", toolId: item.id } : item));
}

function collapse(items: Array<MessagePart | ToolCallBlock>) {
  const tools = items.filter((item): item is ToolCallBlock => "status" in item);
  return collapseToolRuns(partsOf(...items), new Map(tools.map((item) => [item.id, item])));
}

function text(key: string, options?: { count?: number }): string {
  return options?.count === undefined ? key : `${key}#${options.count}`;
}

test("prose splits a batch, and the thought between the calls stays inside it", () => {
  const first = [tool("b1", "bash"), tool("b2", "bash"), tool("b3", "bash")];
  const second = [tool("b4", "bash"), tool("b5", "bash")];
  const folded = collapse([
    { kind: "text", text: "先查清楚" },
    { kind: "thinking", text: "between" },
    ...first,
    { kind: "thinking", text: "after the batch" },
    { kind: "text", text: "Only mine." },
    ...second,
    { kind: "text", text: "进度" },
  ]);
  assert.equal(folded[0]?.kind, "text");
  assert.equal(folded[1]?.kind, "run");
  if (folded[1]?.kind === "run") {
    assert.equal(folded[1].id, "run:b1");
    assert.deepEqual(folded[1].tools.map((item) => item.id), ["b1", "b2", "b3"]);
    assert.equal(folded[1].items.at(-1)?.kind, "thinking");
  }
  assert.equal(folded[2]?.kind, "text");
  assert.equal(folded[3]?.kind, "run");
  if (folded[3]?.kind === "run") assert.deepEqual(folded[3].tools.map((item) => item.id), ["b4", "b5"]);
  assert.equal(folded[4]?.kind, "text");
});

test("a single call between two sentences stays its own row", () => {
  const folded = collapse([{ kind: "text", text: "a" }, tool("b1", "bash"), { kind: "text", text: "b" }]);
  assert.deepEqual(
    folded.map((part) => (part.kind === "tool" ? part.tool.id : part.kind)),
    ["text", "b1", "text"],
  );
});

test("a file change stays in the batch so the summary can name it", () => {
  const folded = collapse([
    tool("b1", "bash"),
    tool("e1", "edit", "done"),
    tool("b2", "read"),
  ]);
  assert.equal(folded[0]?.kind, "run");
  if (folded[0]?.kind === "run") assert.deepEqual(folded[0].tools.map((item) => item.id), ["b1", "e1", "b2"]);
});

test("questions, todos, sub-agents and task graphs stay out", () => {
  for (const name of ["question", "todo", "subagent", "present", "dag_add_tasks", "browser_task", "computer_task"]) {
    assert.equal(foldsIntoRun(name), false, name);
  }
  assert.equal(foldsIntoRun("bash"), true);
  assert.equal(foldsIntoRun("read"), true);
});

test("commands are counted, and a single read or write is named", () => {
  const mixed = runSummary(
    [
      tool("a", "bash"),
      tool("b", "bash"),
      { ...tool("c", "read"), args: { path: "src/main/pi/process-manager.ts" } },
    ],
    text,
  );
  assert.equal(
    mixed.line,
    "common:group.ranCommands#2common:group.separatorcommon:group.readOne process-manager.ts",
  );
  const many = runSummary(
    [
      { ...tool("r1", "read"), args: { path: "a.ts" } },
      { ...tool("r2", "read"), args: { path: "b.ts" } },
      { ...tool("w1", "write"), args: { path: "c.ts" } },
    ],
    text,
  );
  assert.equal(
    many.line,
    "common:group.readMany#2common:group.separatorcommon:group.writeOne c.ts",
  );
  const failed = runSummary([tool("a", "bash"), tool("b", "bash", "error")], text);
  assert.equal(failed.line, "common:group.ranCommands#2 (common:group.failed#1)");
});

test("each category is one clause, however many kinds it gathered", () => {
  // edit and delete join write; search, web and list are one category.
  const writes = runSummary(
    [
      { ...tool("w1", "write"), args: { path: "a.ts" } },
      { ...tool("e1", "edit"), args: { path: "b.ts" } },
      { ...tool("d1", "delete"), args: { path: "c.ts" } },
    ],
    text,
  );
  assert.equal(writes.line, "common:group.writeMany#3");

  // MCP, browser, scripts and skills all report as the tool category.
  const rest = runSummary(
    [
      { ...tool("s1", "grep"), args: { query: "foo" } },
      { ...tool("l1", "ls"), args: { path: "src/main" } },
      tool("m1", "mcp_db_query"),
      tool("m2", "mcp_db_describe_table"),
    ],
    text,
  );
  assert.equal(
    rest.line,
    "common:group.searchMany#2common:group.separatorcommon:group.toolMany#2",
  );
});

test("the live line is the call still running", () => {
  assert.equal(liveTool([tool("a", "bash", "running"), tool("b", "read", "done")])?.id, "a");
  assert.equal(liveTool([tool("a", "bash", "done")]), undefined);
});
