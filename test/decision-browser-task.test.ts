import { test } from "node:test";
import assert from "node:assert/strict";
import { literalText, LoopGuard } from "../src/main/engine/decision/browser-task.ts";

test("the same action on the same state is admitted twice, then refused", () => {
  const guard = new LoopGuard(2);
  const state = { url: "https://a.test/", text: "same" };
  assert.equal(guard.admit(state, "CLICK", "e3"), true);
  assert.equal(guard.admit({ text: "same", url: "https://a.test/" }, "CLICK", "e3"), true, "key order does not matter");
  assert.equal(guard.admit(state, "CLICK", "e3"), false);
  // A different target, or a changed page, is progress.
  assert.equal(guard.admit(state, "CLICK", "e4"), true);
  assert.equal(guard.admit({ ...state, text: "scrolled" }, "CLICK", "e3"), true);
});

test("a single quoted literal is typed as-is; ambiguous or used literals are not", () => {
  assert.equal(literalText('Search Google for "OpenAI GPT-6 Sol" and press Enter'), "OpenAI GPT-6 Sol");
  assert.equal(literalText("在搜索框输入“北京天气”并回车"), "北京天气");
  assert.equal(literalText("输入「机械键盘」，再输入「机械键盘」"), "机械键盘", "one distinct value");
  assert.equal(literalText('Type "Alice" as name and "a@b.c" as email'), null);
  assert.equal(literalText("search for weather in Paris"), null);
  assert.equal(literalText('search "x"', ["x"]), null);
});
