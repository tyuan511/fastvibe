import test from "node:test";
import assert from "node:assert/strict";
import {
  codemodeCalls,
  codemodeCode,
  codemodeFailures,
  codemodeFence,
  codemodeSummary,
  formatCallDuration,
  splitCodemodeSource,
} from "../src/renderer/src/lib/codemode.ts";

test("the script is the call's `code` argument, and nothing else is a script", () => {
  assert.equal(codemodeCode({ code: "return 1;" }), "return 1;");
  assert.equal(codemodeCode({ code: 3 }), "");
  assert.equal(codemodeCode(undefined), "");
  assert.equal(codemodeCode("return 2;"), "return 2;");
});

test("an options line is split off the script", () => {
  const { options, body } = splitCodemodeSource('// @options: {"timeout_ms": 5000}\n\nreturn 1;');
  assert.equal(options, '{"timeout_ms": 5000}');
  assert.equal(body, "return 1;");
  assert.deepEqual(splitCodemodeSource("return 1;"), { body: "return 1;" });
});

test("the summary prefers the model's own leading comment, then the first line of code", () => {
  assert.equal(codemodeSummary("// count the files\nconst n = await tools.ls({});"), "count the files");
  assert.equal(codemodeSummary("const n = await tools.ls({});\nreturn n;"), "const n = await tools.ls({});");
  assert.equal(codemodeSummary('// @options: {"max_output_tokens": 10}\n\n// list them\nreturn 1;'), "list them");
  assert.equal(codemodeSummary(""), "");
});

test("a long first line is shortened", () => {
  const summary = codemodeSummary(`const x = "${"a".repeat(300)}";`, 40);
  assert.equal(summary.length, 41);
  assert.ok(summary.endsWith("…"));
});

test("calls are read from details, skipping anything that is not a call", () => {
  const calls = codemodeCalls({
    calls: [
      { id: "c/1", name: "bash", args: '{"command":"ls"}', status: "ok", durationMs: 12 },
      { id: "c/2", name: "mcp_x_y", args: "{}", status: "error", error: "boom" },
      { name: "no id" },
      "junk",
      { id: "c/3", name: "read", status: "weird" },
    ],
  });
  assert.deepEqual(calls.map((call) => [call.id, call.status]), [["c/1", "ok"], ["c/2", "error"], ["c/3", "running"]]);
  assert.equal(calls[0].durationMs, 12);
  assert.equal(calls[1].error, "boom");
  assert.equal(calls[2].args, "");
});

test("no details, or details without calls, is no calls", () => {
  assert.deepEqual(codemodeCalls(undefined), []);
  assert.deepEqual(codemodeCalls({ fullOutputPath: "/tmp/x" }), []);
  assert.deepEqual(codemodeCalls({ calls: "nope" }), []);
});

test("failures count errors and cut-short calls, not running or ok ones", () => {
  const calls = codemodeCalls({
    calls: [
      { id: "1", name: "a", status: "ok" },
      { id: "2", name: "b", status: "error" },
      { id: "3", name: "c", status: "cancelled" },
      { id: "4", name: "d", status: "running" },
    ],
  });
  assert.equal(codemodeFailures(calls), 2);
});

test("the fence is longer than any run of backticks in the script", () => {
  assert.equal(codemodeFence("return 1;"), "```js\nreturn 1;\n```");
  const withTemplate = "const s = `a ${b}`;";
  assert.ok(codemodeFence(withTemplate).startsWith("```js"));
  const withFence = "const s = '```';\nreturn s;";
  const fenced = codemodeFence(withFence);
  assert.ok(fenced.startsWith("````js\n") && fenced.endsWith("\n````"));
});

test("durations read in ms below a second and in seconds above", () => {
  assert.equal(formatCallDuration(120.4), "120 ms");
  assert.equal(formatCallDuration(1500), "1.5 s");
  assert.equal(formatCallDuration(undefined), "");
  assert.equal(formatCallDuration(-1), "");
});
