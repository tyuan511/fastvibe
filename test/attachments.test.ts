import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachmentPromptSuffix,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  pastedTextAttachmentName,
  resolveDroppedPath,
  shouldAttachPastedText,
  stripAttachmentBlock,
} from "../src/renderer/src/lib/attachments.ts";
import { extractPromptAttachments } from "../src/shared/attachment-metadata.ts";

test("only clipboard text above the composer threshold becomes an attachment", () => {
  assert.equal(shouldAttachPastedText("x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD)), false);
  assert.equal(shouldAttachPastedText("x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD + 1)), true);
  assert.equal(shouldAttachPastedText("短文本"), false);
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

test("attachment-looking text in the middle of a prompt is not stripped", () => {
  const text = "<fastvibe-attachments>\n- /tmp/not-real.txt\n</fastvibe-attachments>\nkeep going";
  assert.equal(stripAttachmentBlock(text), text);
});
