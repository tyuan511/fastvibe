import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import {
  extractPromptAttachments,
  stripPromptMetadata,
} from "../src/shared/attachment-metadata.ts";

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
    // The content rides with the chip. Without it a chip can be drawn but never
    // re-sent, so editing or retrying this turn would silently drop the paste.
    text: content,
  }]);
});

test("an attachment block is still read when the engine's image note follows it", () => {
  // We append the metadata last; pi appends its resize note after the whole text.
  const note = "\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]";
  const prompt = `看下这个图\n\n<fastvibe-attachments>\n- /Users/me/a.md\n</fastvibe-attachments>${note}`;
  assert.deepEqual(extractPromptAttachments(prompt), [
    { id: "file:/Users/me/a.md", kind: "file", name: "a.md", path: "/Users/me/a.md" },
  ]);
  assert.equal(stripAttachmentBlock(prompt), "看下这个图");
});

test("a paste keeps its content when a picture was sent with it", () => {
  const note = "\n\n[Image: original 100x100, displayed at 90x90. Multiply coordinates by 1.11 to map to original image.]";
  const prompt =
    "对比一下\n\n<fastvibe-attachments>\n- /Users/me/a.md\n</fastvibe-attachments>" +
    "\n\n<fastvibe-pasted-text>\n" +
    JSON.stringify([{ name: "粘贴的文本.txt", content: "正文" }]) +
    `\n</fastvibe-pasted-text>${note}`;
  const items = extractPromptAttachments(prompt);
  assert.deepEqual(items.map((item) => item.name), ["a.md", "粘贴的文本.txt"]);
  assert.equal(items[1].text, "正文");
  // What an edit re-sends is what was sent the first time.
  assert.equal(attachmentPromptSuffix(items), prompt.slice(prompt.indexOf("\n\n<fastvibe-attachments>"), prompt.indexOf(note)));
});

test("a prompt that only quotes the note is left alone", () => {
  const quoted = "文档里写着 [Image: original 10x10, displayed at 5x5. Multiply coordinates by 2.00 to map to original image.] 这是什么意思";
  assert.equal(stripAttachmentBlock(quoted), quoted);
  assert.deepEqual(extractPromptAttachments(quoted), []);
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

/**
 * `session-title` runs inside the engine and ships as a loose file, so it cannot import
 * this module — it carries its own copy of the same rules, exactly like it carries its own
 * `SKILL_BLOCK`. A copy that drifts is invisible until a chat is named wrong, so the two
 * are compared by what they leave behind, on the shapes that actually reach a title.
 */
test("the title extension strips the same tail this module strips", () => {
  const source = readFileSync("resources/extensions/session-title.ts", "utf8");
  const written = /const MODEL_FACING_TAIL =\s*\n?\s*\/([\s\S]*?)\/;/.exec(source)?.[1];
  assert.ok(written, "session-title.ts no longer holds a MODEL_FACING_TAIL literal");
  const extensionRule = new RegExp(written, "m");
  const note = "\n\n[Image: original 2160x1684, displayed at 2000x1559. Multiply coordinates by 1.08 to map to original image.]";
  const files = "\n\n<fastvibe-attachments>\n- /Users/me/a.md\n</fastvibe-attachments>";
  const pasted = "\n\n<fastvibe-pasted-text>\n[{\"name\":\"p.txt\",\"content\":\"x\"}]\n</fastvibe-pasted-text>";
  for (const prompt of [`看下这个图${note}`, `词${files}${note}`, `词${files}${pasted}${note}`, files, "没有元数据"]) {
    assert.equal(
      prompt.replace(extensionRule, "").trim(),
      stripPromptMetadata(prompt).trim(),
      prompt,
    );
  }
});
