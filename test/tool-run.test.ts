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

test("prose and a thought both split a batch, and the thought stays its own block", () => {
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
  assert.equal(folded[1]?.kind, "thinking");
  assert.equal(folded[2]?.kind, "run");
  if (folded[2]?.kind === "run") {
    assert.equal(folded[2].id, "run:b1");
    assert.deepEqual(folded[2].tools.map((item) => item.id), ["b1", "b2", "b3"]);
    assert.equal(folded[2].items.some((item) => item.kind !== "tool"), false);
  }
  assert.equal(folded[3]?.kind, "thinking");
  assert.equal(folded[4]?.kind, "text");
  assert.equal(folded[5]?.kind, "run");
  if (folded[5]?.kind === "run") assert.deepEqual(folded[5].tools.map((item) => item.id), ["b4", "b5"]);
  assert.equal(folded[6]?.kind, "text");
});

test("a thought between calls splits them, so they do not fold across it", () => {
  const folded = collapse([
    tool("b1", "bash"),
    tool("b2", "bash"),
    { kind: "thinking", text: "mid" },
    tool("b3", "bash"),
    tool("b4", "bash"),
  ]);
  assert.deepEqual(
    folded.map((part) => (part.kind === "run" ? part.tools.map((item) => item.id).join("+") : part.kind)),
    ["b1+b2", "thinking", "b3+b4"],
  );
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
  const named = mixed.pieces.find((piece) => piece.kind === "file");
  assert.equal(named?.kind === "file" ? named.path : undefined, "src/main/pi/process-manager.ts");
  const query = runSummary([{ ...tool("s1", "grep"), args: { query: "foo", path: "src" } }], text);
  const queried = query.pieces.find((piece) => piece.kind === "file");
  assert.equal(queried?.kind === "file" ? queried.path : "missing", undefined);
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
  assert.equal(failed.line, "common:group.ranCommands#2");
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

test("only the first clause keeps the completed prefix", () => {
  const zh = (key: string, options?: { count?: number }): string => {
    const count = options?.count ?? 0;
    const table: Record<string, string> = {
      "common:group.separator": "，",
      "common:group.ranCommands": `已运行 ${count} 个命令`,
      "common:group.readOne": "已读取",
      "common:group.readMany": `已读取 ${count} 个文件`,
      "common:group.writeOne": "已写入",
    };
    return table[key] ?? key;
  };
  const mixed = runSummary(
    [tool("a", "bash"), tool("b", "bash"), { ...tool("c", "read"), args: { path: "src/a.ts" } }],
    zh,
  );
  assert.equal(mixed.line, "已运行 2 个命令，读取 a.ts");
  const named = mixed.pieces.find((piece) => piece.kind === "file");
  assert.equal(named?.kind === "file" ? named.path : undefined, "src/a.ts");
  const counted = runSummary(
    [tool("a", "bash"), tool("b", "read"), tool("c", "read", "error")],
    zh,
  );
  assert.equal(counted.line, "已运行 1 个命令，读取 2 个文件");
  const en = (key: string, options?: { count?: number }): string => {
    const count = options?.count ?? 0;
    const table: Record<string, string> = {
      "common:group.separator": ", ",
      "common:group.ranCommands": `Ran ${count} commands`,
      "common:group.readMany": `Read ${count} files`,
    };
    return table[key] ?? key;
  };
  assert.equal(
    runSummary([tool("a", "bash"), tool("b", "read"), tool("c", "read")], en).line,
    "Ran 1 commands, read 2 files",
  );
});

test("the live line is the call still running", () => {
  assert.equal(liveTool([tool("a", "bash", "running"), tool("b", "read", "done")])?.id, "a");
  assert.equal(liveTool([tool("a", "bash", "done")]), undefined);
});
