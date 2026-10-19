import assert from "node:assert/strict";
import test from "node:test";
import { SUGGESTION_MAX_CHARS, buildSuggestionPrompt, cleanSuggestion, suggestionMaterial } from "../src/main/engine/reply-suggestion.ts";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });

test("the last finished exchange is the material", () => {
  const material = suggestionMaterial([user("old"), assistant("older"), user("修一下登录"), assistant("已修复")]);
  assert.deepEqual(material, { user: "修一下登录", assistant: "已修复" });
  assert.match(buildSuggestionPrompt(material!), /修一下登录[\s\S]*已修复/);
});

test("a reply that did not end the turn in prose offers nothing to guess from", () => {
  assert.equal(suggestionMaterial([user("go"), assistant("working", "toolUse")]), undefined);
  assert.equal(suggestionMaterial([user("go"), assistant("oops", "error")]), undefined);
  assert.equal(suggestionMaterial([user("go"), assistant("cut", "length")]), undefined);
  assert.equal(suggestionMaterial([user("go"), assistant("")]), undefined);
  assert.equal(suggestionMaterial([user("go")]), undefined);
  assert.equal(suggestionMaterial([]), undefined);
});

test("long text is cut from the front, so the end — what the next message answers — survives", () => {
  const material = suggestionMaterial([user("q"), assistant("a".repeat(5000) + "END")])!;
  assert.ok(material.assistant.length <= 1800);
  assert.ok(material.assistant.endsWith("END"));
});

test("cleaning strips decoration and rejects what is not a message", () => {
  assert.equal(cleanSuggestion("  “帮我补上单元测试”  "), "帮我补上单元测试");
  assert.equal(cleanSuggestion('"Add tests"\n\nBecause the change is untested.'), "Add tests");
  assert.equal(cleanSuggestion("Next message: run the build"), "run the build");
  assert.equal(cleanSuggestion("- 继续下一步"), "继续下一步");
  assert.equal(cleanSuggestion("「好的，继续」"), "好的，继续");
  assert.equal(cleanSuggestion("NONE"), undefined);
  assert.equal(cleanSuggestion("none."), undefined);
  assert.equal(cleanSuggestion("   \n "), undefined);
  assert.equal(cleanSuggestion("x".repeat(SUGGESTION_MAX_CHARS + 1)), undefined);
  assert.equal(cleanSuggestion("x".repeat(SUGGESTION_MAX_CHARS)), "x".repeat(SUGGESTION_MAX_CHARS));
});

import { withFinalMessage } from "../src/main/engine/reply-suggestion.ts";

test("the reply that just ended is on the end exactly once, whether or not the transcript has it yet", () => {
  const first = { role: "user", content: "q", timestamp: 1 };
  const reply = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "a" }], timestamp: 2 };
  assert.deepEqual(withFinalMessage([first], reply), [first, reply], "not there yet: appended");
  assert.deepEqual(withFinalMessage([first, reply], reply), [first, reply], "already there: not doubled");
  assert.deepEqual(withFinalMessage([first, { ...reply }], reply), [first, reply], "a copy of it (same role and time) counts as the same message");
  assert.deepEqual(withFinalMessage([], reply), [reply]);
  const inputs = [first];
  withFinalMessage(inputs, reply);
  assert.equal(inputs.length, 1, "the transcript is not mutated");
});

import { completedFirstLine, readSuggestionStream } from "../src/main/engine/reply-suggestion.ts";

function fakeStream(deltas: string[], final: Record<string, unknown>) {
  let cancelled = false;
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) {
        if (cancelled) return;
        yield { type: "text_delta", delta };
      }
    },
    result: async () => ({ stopReason: "stop", content: [], ...final }),
  };
  return { stream, cancel: () => { cancelled = true; }, wasCancelled: () => cancelled };
}

test("a line is only finished once a newline follows content", () => {
  assert.equal(completedFirstLine("帮我写测试"), undefined);
  assert.equal(completedFirstLine("帮我写测试\n"), "帮我写测试");
  assert.equal(completedFirstLine("\n\n  帮我写测试 \n其余的解释"), "帮我写测试");
  assert.equal(completedFirstLine("   "), undefined);
});

test("the stream is cancelled the moment the line is complete, and what follows is never read", async () => {
  const f = fakeStream(["帮我", "补上", "测试", "\n", "因为这次改动", "没有覆盖"], { usage: { output: 9 } });
  const out = await readSuggestionStream(f.stream as never, f.cancel);
  assert.equal(f.wasCancelled(), true);
  assert.equal(out.stopReason, "stop", "an early stop is a finished answer, not an abort");
  assert.deepEqual(out.content, [{ type: "text", text: "帮我补上测试" }]);
  assert.deepEqual(out.usage, { output: 9 });
});

test("a single line that simply ends is returned as the stream reported it", async () => {
  const f = fakeStream(["Add tests"], { content: [{ type: "text", text: "Add tests" }] });
  const out = await readSuggestionStream(f.stream as never, f.cancel);
  assert.equal(f.wasCancelled(), false);
  assert.deepEqual(out.content, [{ type: "text", text: "Add tests" }]);
});

test("a stream that ends in an error or a cut-off keeps that ending", async () => {
  const failed = fakeStream([], { stopReason: "error", errorMessage: "502" });
  assert.equal((await readSuggestionStream(failed.stream as never, failed.cancel)).stopReason, "error");
  const cut = fakeStream(["partial"], { stopReason: "length", content: [] });
  assert.equal((await readSuggestionStream(cut.stream as never, cut.cancel)).stopReason, "length");
});
