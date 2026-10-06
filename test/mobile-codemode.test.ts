import test from "node:test";
import assert from "node:assert/strict";
import {
  codemodeBody,
  codemodeCalls,
  codemodeCode,
  codemodeFailures,
  codemodeSummary,
  formatCallDuration,
  nestedParent,
  toolEventDetails,
  toolResultText,
} from "../apps/mobile/src/chat/codemode.ts";

test("the script is the call's `code`, and nothing else is a script", () => {
  assert.equal(codemodeCode({ code: "return 1;" }), "return 1;");
  assert.equal(codemodeCode({ code: 3 }), "");
  assert.equal(codemodeCode(undefined), "");
});

test("an options line is not part of the script that is shown", () => {
  assert.equal(codemodeBody('// @options: {"timeout_ms": 5}\n\nreturn 1;'), "return 1;");
  assert.equal(codemodeBody("return 1;"), "return 1;");
});

test("the summary prefers the model's leading comment, then the first line of code", () => {
  assert.equal(codemodeSummary("// count the files\nconst n = 1;"), "count the files");
  assert.equal(codemodeSummary("const n = 1;\nreturn n;"), "const n = 1;");
  assert.equal(codemodeSummary('// @options: {"a":1}\n\n// list them\nreturn 1;'), "list them");
  assert.equal(codemodeSummary(""), "");
  assert.equal(codemodeSummary(`const x = "${"a".repeat(300)}";`, 20).length, 21);
});

test("calls are read from details, skipping anything that is not a call", () => {
  const calls = codemodeCalls({
    calls: [
      { id: "c/1", name: "bash", args: "{}", status: "ok", durationMs: 12 },
      { id: "c/2", name: "x", status: "error", error: "boom" },
      { name: "no id" },
      "junk",
      { id: "c/3", name: "read", status: "weird" },
    ],
  });
  assert.deepEqual(calls.map((call) => [call.id, call.status]), [["c/1", "ok"], ["c/2", "error"], ["c/3", "running"]]);
  assert.equal(calls[1].error, "boom");
  assert.deepEqual(codemodeCalls(undefined), []);
  assert.deepEqual(codemodeCalls({ calls: "nope" }), []);
});

test("failures count errors and cut-short calls", () => {
  const calls = codemodeCalls({ calls: [{ id: "1", name: "a", status: "ok" }, { id: "2", name: "b", status: "error" }, { id: "3", name: "c", status: "cancelled" }, { id: "4", name: "d", status: "running" }] });
  assert.equal(codemodeFailures(calls), 2);
});

test("durations", () => {
  assert.equal(formatCallDuration(120.4), "120 ms");
  assert.equal(formatCallDuration(1500), "1.5 s");
  assert.equal(formatCallDuration(undefined), "");
});

test("a call a tool made itself names its parent; one the model made does not", () => {
  assert.equal(nestedParent({ type: "tool_execution_start", toolCallId: "c/1", parentToolCallId: "c" }), "c");
  assert.equal(nestedParent({ type: "tool_execution_start", toolCallId: "c" }), undefined);
  assert.equal(nestedParent({ parentToolCallId: "" }), undefined);
  assert.equal(nestedParent({ parentToolCallId: 4 }), undefined);
});

test("a tool event's details are found on the event or inside its result", () => {
  assert.deepEqual(toolEventDetails({ details: { a: 1 } }), { a: 1 });
  assert.deepEqual(toolEventDetails({ partialResult: { content: [], details: { calls: [] } } }), { calls: [] });
  assert.deepEqual(toolEventDetails({ result: { content: [], details: { b: 2 } } }), { b: 2 });
  assert.equal(toolEventDetails({}), undefined);
});

test("a result's text is its text parts, not its JSON", () => {
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(toolResultText({ content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }], details: {} }), "a\nb");
  assert.equal(toolResultText({ content: [], details: { calls: [] } }), undefined, "a progress-only update has no text");
  assert.equal(toolResultText(undefined), undefined);
  assert.equal(toolResultText({ ok: true }), '{"ok":true}');
});
