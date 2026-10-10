import assert from "node:assert/strict";
import { test } from "node:test";
import { SUMMARY_RESULT_INLINE, SUMMARY_STRING_HEAD, summarizeToolBlock, summarizeToolCalls } from "../src/shared/tool-summary.ts";
import type { ChatMessage, ToolCallBlock } from "../src/shared/types.ts";

const tool = (over: Partial<ToolCallBlock>): ToolCallBlock => ({ id: "t1", name: "read", status: "done", ...over });
const message = (tools: ToolCallBlock[]): ChatMessage => ({ id: "m1", role: "assistant", text: "", tools, createdAt: 1 });

test("a long result is left out and its length recorded; a short one stays", () => {
  const long = "x".repeat(SUMMARY_RESULT_INLINE + 1);
  const slim = summarizeToolBlock(tool({ args: { path: "src/a.ts" }, result: long }));
  assert.equal(slim.result, undefined);
  assert.deepEqual(slim.omitted, { result: long.length });
  assert.deepEqual(slim.args, { path: "src/a.ts" }, "what the line is drawn from is kept");

  const short = tool({ result: "ok" });
  assert.equal(summarizeToolBlock(short), short, "a block with nothing to leave out is not copied");
});

test("long strings in the arguments are cut, wherever they sit, and the shape is kept", () => {
  const body = "y".repeat(5000);
  const slim = summarizeToolBlock(tool({
    name: "edit",
    args: { path: "src/a.ts", edits: [{ oldText: body, newText: "short" }], count: 3, flag: true, nothing: null },
  }));
  const args = slim.args as { path: string; edits: Array<{ oldText: string; newText: string }>; count: number; flag: boolean; nothing: null };
  assert.equal(args.path, "src/a.ts");
  assert.equal(args.edits[0].oldText.length, SUMMARY_STRING_HEAD + 1);
  assert.ok(args.edits[0].oldText.endsWith("…"));
  assert.equal(args.edits[0].newText, "short");
  assert.deepEqual([args.count, args.flag, args.nothing], [3, true, null]);
  assert.deepEqual(slim.omitted, { args: true });
});

test("details are cut the same way", () => {
  const slim = summarizeToolBlock(tool({ name: "edit", details: { diff: "d".repeat(3000), firstChangedLine: 12 } }));
  const details = slim.details as { diff: string; firstChangedLine: number };
  assert.equal(details.diff.length, SUMMARY_STRING_HEAD + 1);
  assert.equal(details.firstChangedLine, 12);
  assert.deepEqual(slim.omitted, { details: true });
});

test("a call that is drawn from its arguments keeps them whole", () => {
  const long = "z".repeat(2000);
  for (const name of ["todo", "question", "subagent", "dag_add_tasks"]) {
    const block = tool({ name, args: { items: [{ text: long }] }, details: { note: long }, result: long });
    const slim = summarizeToolBlock(block);
    assert.deepEqual(slim.args, block.args, name);
    assert.deepEqual(slim.details, block.details, name);
    assert.deepEqual(slim.omitted, { result: long.length }, `${name}: only the result is left out`);
  }
});

test("a call still running is sent as it is", () => {
  const running = tool({ status: "running", result: "r".repeat(10_000), args: { command: "c".repeat(9000) } });
  assert.equal(summarizeToolBlock(running), running);
});

test("the source block is never changed, and messages without tools are shared", () => {
  const long = "x".repeat(1000);
  const block = tool({ result: long, args: { text: long } });
  const plain: ChatMessage = { id: "u1", role: "user", text: "hi", tools: [], createdAt: 1 };
  const withTools = message([block]);
  const out = summarizeToolCalls([plain, withTools]);
  assert.equal(out[0], plain);
  assert.notEqual(out[1], withTools);
  assert.equal(block.result, long);
  assert.deepEqual(block.args, { text: long });
  assert.equal(block.omitted, undefined);
  assert.equal(out[1].tools[0].omitted?.result, 1000);
});
