import assert from "node:assert/strict";
import test from "node:test";

import { promptPreview } from "../src/main/engine/prompt-preview.ts";

/**
 * The title a chat wears until session-title names it — and, when that call never
 * landed, for good. It is a head-cut of the first prompt, so it has to say so.
 */

test("a truncated fallback title is marked as a cut", () => {
  const prompt = "帮我把登录接口里的 token 刷新逻辑重写一遍，然后补上单元测试和错误码的处理";
  const { title } = promptPreview({}, prompt);
  assert.ok(title.endsWith("…"), title);
  assert.ok(prompt.startsWith(title.slice(0, -1)));
});

test("the cut title stays inside the same ceiling it always had", () => {
  const title = promptPreview({}, "x".repeat(400)).title;
  assert.equal(title.length, 24);
  assert.equal(title, `${"x".repeat(23)}…`);
});

test("a prompt that fits is the title, with nothing appended", () => {
  const prompt = "a".repeat(24);
  assert.equal(promptPreview({}, prompt).title, prompt);
  assert.equal(promptPreview({}, "重构登录中间件").title, "重构登录中间件");
});

test("the character the cut lands on is not left dangling as whitespace", () => {
  // 23 characters, then a space: the ellipsis follows the word, not the gap.
  const { title } = promptPreview({}, "refactor the login middleware and add tests");
  assert.equal(title, "refactor the login midd…");
});

test("an empty prompt still gives the chat a name", () => {
  assert.equal(promptPreview({}, "   ").title, "新会话");
  assert.equal(promptPreview({}, "").preview, "");
});

test("the preview keeps its own length, the title is the one that is shorter", () => {
  const { preview } = promptPreview({}, "a".repeat(200));
  assert.equal(preview.length, 80);
});

test("a name the chat already has is never re-cut", () => {
  assert.equal(promptPreview({ title: "登录校验" }, "x".repeat(200)).title, "登录校验");
  assert.equal(promptPreview({ title: "新会话", titleManual: true }, "x".repeat(200)).title, "新会话");
});

test("the engine's image note does not become the chat's name", () => {
  const note = "\n\n[Image: original 2160x1684, displayed at 2000x1559. Multiply coordinates by 1.08 to map to original image.]";
  const prompt = `看下这个图的报错${note}`;
  const { title, preview } = promptPreview({}, prompt);
  assert.equal(title, "看下这个图的报错");
  assert.equal(preview, "看下这个图的报错");
});

test("a prompt that is only a picture is still named, so the row is not blank", () => {
  const note = "\n\n[Image: original 2160x1684, displayed at 2000x1559. Multiply coordinates by 1.08 to map to original image.]";
  assert.equal(promptPreview({}, note).preview, "图片");
});

test("a prompt that is only a file is named by that file", () => {
  const { title, preview } = promptPreview({}, "x".repeat(0) + "\n\n<fastvibe-attachments>\n- /Users/me/paper.pdf\n</fastvibe-attachments>");
  assert.equal(preview, "paper.pdf");
  assert.equal(title, "paper.pdf");
});
