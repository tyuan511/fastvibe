import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachmentPromptSuffix,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  pastedTextAttachmentName,
  resolveDroppedPath,
  shouldAttachPastedText,
  shouldFoldPastedText,
  stripAttachmentBlock,
  stripImageDimensionNote,
} from "../src/renderer/src/lib/attachments.ts";
import { extractPromptAttachments } from "../src/shared/attachment-metadata.ts";

test("only clipboard text above the composer threshold becomes an attachment", () => {
  assert.equal(shouldAttachPastedText("x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD)), false);
  assert.equal(shouldAttachPastedText("x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD + 1)), true);
  assert.equal(shouldAttachPastedText("短文本"), false);
});

test("the transcript folds a prompt only past the same line the composer folds at", () => {
  // The bug this replaced was a two-rendered-line clamp with no length floor: a
  // hundred-character prompt became a fold the reader had to open before reading it.
  const prompt =
    "探索一下使用rust+gpui重写整个应用的可能性，使用自研agent参考 https://github.com/can1357/oh-my-pi 的实现，ui层使用gpui实现高性能绘制，给我一个可行性分析";
  assert.ok(prompt.length < PASTED_TEXT_ATTACHMENT_THRESHOLD, "the fixture is a short prompt");
  assert.equal(shouldFoldPastedText(prompt), false);
  assert.equal(shouldFoldPastedText("x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD)), false);
  assert.equal(shouldFoldPastedText("x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD + 1)), true);
});

test("a long paste is named from its first 32 graphemes", () => {
  assert.equal(pastedTextAttachmentName("你好世界这是一段很长的粘贴内容，后面还有很多字"), "你好世界这是一段很长的粘贴内容，后面还有很多字");
  assert.equal(pastedTextAttachmentName("\n\n  Hello world, this is long"), "Hello world, this is long");
  assert.equal(pastedTextAttachmentName("   \n\n   "), "");
});

test("a long paste stays model-visible but is hidden behind a file-style chip", () => {
  const content = "第一行\n第二行\n</fastvibe-pasted-text> 也只是正文";
  const suffix = attachmentPromptSuffix([{
    id: "paste-1",
    kind: "file",
    name: "粘贴的文本.txt",
    mimeType: "text/plain",
    text: content,
  }]);
  const prompt = `请分析这段内容${suffix}`;

  assert.match(prompt, /第一行/);
  assert.equal(stripAttachmentBlock(prompt), "请分析这段内容");
  assert.deepEqual(extractPromptAttachments(prompt), [{
    id: "pasted:0:粘贴的文本.txt",
    kind: "file",
    name: "粘贴的文本.txt",
    mimeType: "text/plain",
  }]);
});

test("a dropped file keeps the preload path, not the empty File.path Electron left behind", () => {
  assert.equal(resolveDroppedPath(undefined, "/Users/me/paper.pdf"), "/Users/me/paper.pdf");
  assert.equal(resolveDroppedPath("", "/Users/me/paper.pdf"), "/Users/me/paper.pdf");
  assert.equal(resolveDroppedPath("/legacy/notes.md", ""), "/legacy/notes.md");
  assert.equal(resolveDroppedPath(undefined, ""), undefined);
  assert.equal(resolveDroppedPath("   ", "  "), undefined);
});

test("a file chip with no path adds nothing for the model to open", () => {
  assert.equal(attachmentPromptSuffix([
    { id: "pdf", kind: "file", name: "paper.pdf", mimeType: "application/pdf" },
  ]), "");
});

test("real file chips are still rebuilt from the persisted prompt suffix", () => {
  const text = [
    "请查看附件",
    "",
    "<fastvibe-attachments>",
    "- /tmp/one/notes.md",
    "</fastvibe-attachments>",
  ].join("\n");

  assert.deepEqual(extractPromptAttachments(text), [{
    id: "file:/tmp/one/notes.md",
    kind: "file",
    name: "notes.md",
    path: "/tmp/one/notes.md",
  }]);
});

test("attachment-only prompts keep their chips without adding visible text", () => {
  const items = [
    { id: "file", kind: "file" as const, name: "notes.md", path: "/tmp/notes.md" },
    { id: "paste", kind: "file" as const, name: "pasted.txt", text: "粘贴的正文" },
  ];
  for (const attachments of [[items[0]], [items[1]], items]) {
    const payload = attachmentPromptSuffix(attachments);
    assert.equal(stripAttachmentBlock(payload), "");
    assert.deepEqual(extractPromptAttachments(payload).map((item) => item.name), attachments.map((item) => item.name));
  }
});

test("attachment-looking text in the middle of a prompt is not stripped", () => {
  const text = "<fastvibe-attachments>\n- /tmp/not-real.txt\n</fastvibe-attachments>\nkeep going";
  assert.equal(stripAttachmentBlock(text), text);
});

test("the image resize note the engine appends is hidden, and a quoted one is not", () => {
  const note = "[Image: original 922x2048, displayed at 900x2000. Multiply coordinates by 1.02 to map to original image.]";
  assert.equal(stripImageDimensionNote(`这个底部的切角太丑了\n\n${note}`), "这个底部的切角太丑了");
  assert.equal(stripAttachmentBlock(`看这两张\n\n${note}\n\n${note}`), "看这两张");
  const quoted = `引擎会写这么一句：${note}，然后继续`;
  assert.equal(stripImageDimensionNote(quoted), quoted);
  assert.equal(stripAttachmentBlock("请看这张"), "请看这张");
});
