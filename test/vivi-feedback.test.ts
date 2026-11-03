import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { viviFeedbackKey, type ViviFeedbackAction } from "../src/renderer/src/lib/vivi-feedback.ts";

const locales = ["zh", "en"].map((lang) => JSON.parse(readFileSync(new URL(`../src/renderer/src/locales/${lang}/app.json`, import.meta.url), "utf8")).viviBot.feedback as Record<string, string>);

test("Vivi 未知长错误按操作给出短结论，不把原始异常放到主聊天", () => {
  const raw = `Unexpected error: ${"diagnostic ".repeat(300)}\n    at file:///Users/example/private/config.ts:123:4\n${JSON.stringify({ error: { message: "raw provider details" } })}`;
  const error = new Error(raw);
  for (const action of ["load", "send", "stop", "answer", "execution"] satisfies ViviFeedbackAction[]) {
    const key = viviFeedbackKey(error, action);
    assert.equal(key, `viviBot.feedback.${action}`);
    for (const copy of locales) {
      assert.ok(copy[action]);
      assert.doesNotMatch(copy[action], /diagnostic|file:\/\/\/|raw provider/);
    }
  }
  assert.equal(error.message, raw, "诊断信息不截断或改写");
});

test("Vivi 错误保留可行动的原因，配额不足不误报为请求频繁", () => {
  for (const [raw, reason] of [
    ['429: {"error":{"type":"insufficient_quota","message":"Long quota diagnostic"}}', "quota"],
    ['401: {"error":{"message":"Authentication failed"}}', "auth"],
    ['400: {"error":{"code":"invalid_api_key","message":"Bad key"}}', "auth"],
    ["429: too many requests", "rateLimit"],
    ["503 status code (no body)", "network"],
    ["Connection error.", "network"],
    ["EACCES: permission denied, open '/private/report.md'", "permission"],
    ["会话已暂停，请先继续", "paused"],
    ["这个问题已处理或过期", "questionExpired"],
    ["请先回答当前问题。", "pendingQuestion"],
    ["Please answer the pending question first.", "pendingQuestion"],
  ]) assert.equal(viviFeedbackKey(raw, "execution"), `viviBot.feedback.${reason}`);
  assert.equal(viviFeedbackKey("stack frame at line 503 in config.ts", "load"), "viviBot.feedback.load");
  assert.equal(viviFeedbackKey(undefined, "send"), "viviBot.feedback.send");
});

test("Vivi 中英文错误文案最多两句，未知操作结果不冒充已停止或已完成", () => {
  assert.deepEqual(Object.keys(locales[0]).sort(), Object.keys(locales[1]).sort());
  for (const locale of locales) for (const [key, copy] of Object.entries(locale)) {
    assert.ok(copy.length < 200, key);
    assert.ok((copy.match(/[.!?。！？](?:\s|$)/g) ?? []).length <= 2, key);
    assert.doesNotMatch(copy, /\n|Worker|Router|epoch|conversationId/);
  }
  assert.match(locales[0].stop, /没能确认/);
  assert.match(locales[0].execution, /没有完成/);
});
