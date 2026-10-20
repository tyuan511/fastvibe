import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessagePart, ToolCallBlock } from "../src/shared/types.ts";
import {
  collapseToolRuns,
  foldsIntoRun,
  liveTool,
  runSummary,
  type RunItem,
} from "../src/renderer/src/lib/tool-run.ts";

function tool(id: string, name: string, status: ToolCallBlock["status"] = "done"): ToolCallBlock {
  return { id, name, status };
}

function thought(text: string): MessagePart {
  return { kind: "thinking", text };
}

function thinkItem(text: string, live = false): RunItem {
  const part: Extract<MessagePart, { kind: "thinking" }> = { kind: "thinking", text };
  return { kind: "thinking", part, live };
}

function partsOf(...items: Array<MessagePart | ToolCallBlock>): MessagePart[] {
  return items.map((item) => ("status" in item ? { kind: "tool", toolId: item.id } : item));
}

function collapse(items: Array<MessagePart | ToolCallBlock>, options?: { collapseThinking?: boolean; streaming?: boolean }) {
  const tools = items.filter((item): item is ToolCallBlock => "status" in item);
  return collapseToolRuns(partsOf(...items), new Map(tools.map((item) => [item.id, item])), options);
}

/** `runSummary` reads a run's items; a test that only cares about calls wraps them. */
function items(...tools: ToolCallBlock[]): RunItem[] {
  return tools.map((tool) => ({ kind: "tool", tool }));
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

test("a part nobody can see does not break the run", () => {
  // The shape read off a real transcript: a provider finished a reasoning block whose whole
  // text was one space, between two shell calls. 空的思考不占一行 hides it, so a break it
  // caused was invisible — 「已运行 6 个命令」 and 「已运行 2 个命令」 with nothing between them.
  const blankThought = collapse([tool("b1", "bash"), tool("b2", "bash"), thought(" "), tool("b3", "bash")]);
  assert.deepEqual(
    blankThought.map((part) => (part.kind === "run" ? part.tools.map((item) => item.id).join("+") : part.kind)),
    ["b1+b2+b3"],
  );

  // Same for prose the reader never sees (模型输出的空白不占一整屏).
  const blankProse = collapse([tool("b1", "bash"), { kind: "text", text: "\n  " }, tool("b2", "bash")]);
  assert.deepEqual(
    blankProse.map((part) => (part.kind === "run" ? part.tools.map((item) => item.id).join("+") : part.kind)),
    ["b1+b2"],
  );

  // A blank thought at the tail of a run that is still going is *not* invisible — 「正在思考」
  // is a true report of work in flight — so it still breaks the batch.
  const liveTail = collapse([tool("b1", "bash"), thought(" ")], { streaming: true });
  assert.deepEqual(
    liveTail.map((part) => part.kind),
    ["tool", "thinking"],
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
  for (const name of ["question", "todo", "subagent", "present", "dag_add_tasks"]) {
    assert.equal(foldsIntoRun(name), false, name);
  }
  assert.equal(foldsIntoRun("bash"), true);
  assert.equal(foldsIntoRun("read"), true);
  // The browser and computer step tools are ordinary calls: the whole batch is the
  // model stepping itself, so the summary row names it. (The removed decision engine had
  // its own `browser_task` / `computer_task` cards; nothing by those names exists now.)
  assert.equal(foldsIntoRun("browser_click"), true);
  assert.equal(foldsIntoRun("computer_window_state"), true);
});

test("commands are counted, and a single read or write is named", () => {
  const mixed = runSummary(
    items(
      tool("a", "bash"),
      tool("b", "bash"),
      { ...tool("c", "read"), args: { path: "src/main/pi/process-manager.ts" } },
    ),
    text,
  );
  assert.equal(
    mixed.line,
    "common:group.ranCommands#2common:group.separatorcommon:group.readOne process-manager.ts",
  );
  const named = mixed.pieces.find((piece) => piece.kind === "file");
  assert.equal(named?.kind === "file" ? named.path : undefined, "src/main/pi/process-manager.ts");
  const query = runSummary(items({ ...tool("s1", "grep"), args: { query: "foo", path: "src" } }), text);
  const queried = query.pieces.find((piece) => piece.kind === "file");
  assert.equal(queried?.kind === "file" ? queried.path : "missing", undefined);
  const many = runSummary(
    items(
      { ...tool("r1", "read"), args: { path: "a.ts" } },
      { ...tool("r2", "read"), args: { path: "b.ts" } },
      { ...tool("w1", "write"), args: { path: "c.ts" } },
    ),
    text,
  );
  assert.equal(
    many.line,
    "common:group.readMany#2common:group.separatorcommon:group.writeOne c.ts",
  );
  const failed = runSummary(items(tool("a", "bash"), tool("b", "bash", "error")), text);
  assert.equal(failed.line, "common:group.ranCommands#2");
});

test("each category is one clause, however many kinds it gathered", () => {
  // edit and delete join write; search, web and list are one category.
  const writes = runSummary(
    items(
      { ...tool("w1", "write"), args: { path: "a.ts" } },
      { ...tool("e1", "edit"), args: { path: "b.ts" } },
      { ...tool("d1", "delete"), args: { path: "c.ts" } },
    ),
    text,
  );
  assert.equal(writes.line, "common:group.writeMany#3");

  // MCP, browser, scripts and skills all report as the tool category.
  const rest = runSummary(
    items(
      { ...tool("s1", "grep"), args: { query: "foo" } },
      { ...tool("l1", "ls"), args: { path: "src/main" } },
      tool("m1", "mcp_db_query"),
      tool("m2", "mcp_db_describe_table"),
    ),
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
    items(tool("a", "bash"), tool("b", "bash"), { ...tool("c", "read"), args: { path: "src/a.ts" } }),
    zh,
  );
  assert.equal(mixed.line, "已运行 2 个命令，读取 a.ts");
  const named = mixed.pieces.find((piece) => piece.kind === "file");
  assert.equal(named?.kind === "file" ? named.path : undefined, "src/a.ts");
  const counted = runSummary(items(tool("a", "bash"), tool("b", "read"), tool("c", "read", "error")), zh);
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
    runSummary(items(tool("a", "bash"), tool("b", "read"), tool("c", "read")), en).line,
    "Ran 1 commands, read 2 files",
  );
});

test("the live line is the call still running", () => {
  assert.equal(liveTool([tool("a", "bash", "running"), tool("b", "read", "done")])?.id, "a");
  assert.equal(liveTool([tool("a", "bash", "done")]), undefined);
});

/** A settled line in Chinese, spelled out so the 「已」 rule is visible in the assertion. */
function zh(key: string, options?: { count?: number }): string {
  const count = options?.count ?? 0;
  const table: Record<string, string> = {
    "common:group.separator": "，",
    "common:group.thoughts": `已思考 ${count} 次`,
    "common:group.ranCommands": `已运行 ${count} 个命令`,
    "common:group.readOne": "已读取",
  };
  return table[key] ?? key;
}

test("折叠思考内容 folds a thought into the batch it sits in", () => {
  const folded = collapse(
    [
      { kind: "text", text: "先查清楚" },
      thought("看哪个文件定义它"),
      tool("b1", "bash"),
      tool("b2", "bash"),
      thought("原来在 process-manager"),
      { ...tool("r1", "read"), args: { path: "src/a.ts" } },
      { kind: "text", text: "进度" },
    ],
    { collapseThinking: true },
  );
  assert.deepEqual(
    folded.map((part) => (part.kind === "run" ? part.items.length : part.kind)),
    ["text", 5, "text"],
  );
  const run = folded[1];
  if (run?.kind !== "run") throw new Error("expected a run");
  assert.equal(run.id, "run:b1");
  assert.deepEqual(run.items.map((item) => item.kind), ["thinking", "tool", "tool", "thinking", "tool"]);
  // The tools are still the batch's own — previews and the expanded body read them off `tools`.
  assert.deepEqual(run.tools.map((item) => item.id), ["b1", "b2", "r1"]);
  assert.equal(run.liveThinking, undefined);
});

test("the folded thought is counted, in the order it first appeared", () => {
  assert.equal(
    runSummary(
      [thinkItem("a"), { kind: "tool", tool: tool("b1", "bash") }, { kind: "tool", tool: tool("b2", "bash") }, thinkItem("c")],
      zh,
    ).line,
    "已思考 2 次，运行 2 个命令",
  );
  // The thought came after the call, so it is the later clause and drops its 「已」.
  assert.equal(
    runSummary([{ kind: "tool", tool: tool("b1", "bash") }, thinkItem("a")], zh).line,
    "已运行 1 个命令，思考 1 次",
  );
  assert.equal(
    runSummary([thinkItem("a"), { kind: "tool", tool: { ...tool("r1", "read"), args: { path: "src/a.ts" } } }], zh).line,
    "已思考 1 次，读取 a.ts",
  );
  assert.equal(
    runSummary(
      [{ kind: "tool", tool: { ...tool("r1", "read"), args: { path: "a.ts" } } }, thinkItem("a"), { kind: "tool", tool: tool("b1", "bash") }],
      zh,
    ).line,
    "已读取 a.ts，思考 1 次，运行 1 个命令",
  );
});

test("a thought with no call around it keeps its own row", () => {
  // The option folds thinking *into the tool summary*. Two thoughts with no call between
  // them have no summary to join, and hiding them behind a row would be a worse fold.
  const folded = collapse([thought("one"), thought("two")], { collapseThinking: true });
  assert.deepEqual(folded.map((part) => part.kind), ["thinking", "thinking"]);

  // A question or a task graph is its own card, so the thought before it stays alone too.
  const before = collapse([thought("one"), tool("q1", "question")], { collapseThinking: true });
  assert.deepEqual(before.map((part) => part.kind), ["thinking", "tool"]);
});

test("a blank thought is not counted and does not split the batch", () => {
  const folded = collapse([tool("b1", "bash"), thought("  "), tool("b2", "bash")], { collapseThinking: true });
  assert.deepEqual(folded.map((part) => part.kind), ["run"]);
  if (folded[0]?.kind !== "run") throw new Error("expected a run");
  assert.equal(folded[0].items.length, 2);
  assert.equal(folded[0].liveThinking, undefined);
});

test("only the tail thought of a streaming reply is live", () => {
  const parts: Array<MessagePart | ToolCallBlock> = [tool("b1", "bash"), thought("still writing")];
  const live = collapse(parts, { collapseThinking: true, streaming: true });
  if (live[0]?.kind !== "run") throw new Error("expected a run");
  assert.equal(live[0].liveThinking?.text, "still writing");

  const settled = collapse(parts, { collapseThinking: true, streaming: false });
  if (settled[0]?.kind !== "run") throw new Error("expected a run");
  assert.equal(settled[0].liveThinking, undefined);

  // A thought that is not the reply's last part is never live, streaming or not.
  const middle = collapse([thought("done"), tool("b1", "bash")], { collapseThinking: true, streaming: true });
  if (middle[0]?.kind !== "run") throw new Error("expected a run");
  assert.equal(middle[0].liveThinking, undefined);
});
