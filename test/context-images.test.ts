import test from "node:test";
import assert from "node:assert/strict";
import { dropOldToolImages, MAX_KEPT_IMAGE_CHARS } from "../src/main/engine/context-images.ts";

const image = (data: string) => ({ type: "image", data, mimeType: "image/png" });
const result = (id: string, ...blocks: unknown[]) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }, ...blocks] });
const imagesOf = (messages: readonly unknown[]) =>
  (messages as Array<{ content?: Array<{ type: string; data?: string }> }>).flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "image").map((b) => b.data));
const third = "x".repeat(Math.floor(MAX_KEPT_IMAGE_CHARS / 3));

test("pictures that fit the budget come back as the very same array", () => {
  const messages = Array.from({ length: 30 }, (_, i) => result(`c${i}`, image("small")));
  assert.equal(dropOldToolImages(messages), messages);
});

test("over budget, the oldest go first and the newest stay", () => {
  const messages = Array.from({ length: 6 }, (_, i) => result(`c${i}`, image(`${i}${third}`)));
  const trimmed = dropOldToolImages(messages);
  assert.deepEqual(imagesOf(trimmed).map((d) => d![0]), ["4", "5"]);
  const note = (trimmed[0] as { content: Array<{ type: string; text?: string }> }).content[1];
  assert.equal(note.type, "text");
  assert.match(note.text ?? "", /left out of the context/);
});

test("the newest picture is kept even when it alone is over budget", () => {
  const messages = [result("a", image("y".repeat(MAX_KEPT_IMAGE_CHARS * 2)))];
  assert.equal(dropOldToolImages(messages), messages);
  const two = [result("a", image("1")), result("b", image("y".repeat(MAX_KEPT_IMAGE_CHARS * 2)))];
  assert.equal(imagesOf(dropOldToolImages(two)).length, 1);
});

test("several images in one result are counted one by one", () => {
  const messages = [result("a", image(`1${third}`), image(`2${third}`), image(`3${third}`)), result("b", image(`4${third}`), image(`5${third}`))];
  assert.deepEqual(imagesOf(dropOldToolImages(messages)).map((d) => d![0]), ["4", "5"]);
});

test("images the user attached, and messages that are not touched, are left alone", () => {
  const attached = { role: "user", content: [{ type: "text", text: "see" }, image("mine".repeat(MAX_KEPT_IMAGE_CHARS))] };
  const messages: unknown[] = [attached, ...Array.from({ length: 6 }, (_, i) => result(`c${i}`, image(`${i}${third}`)))];
  const trimmed = dropOldToolImages(messages);
  assert.equal(trimmed[0], attached);
  assert.equal(trimmed[6], messages[6]);
  assert.equal(imagesOf(trimmed).length, 3);
});

test("the input is not mutated", () => {
  const messages = Array.from({ length: 6 }, (_, i) => result(`c${i}`, image(`${i}${third}`)));
  const before = structuredClone(messages);
  dropOldToolImages(messages);
  assert.deepEqual(messages, before);
});

test("a dropped picture's note names the saved copy, by the picture's place in its own result", () => {
  const messages = [result("a", image(`0${third}`), image(`1${third}`)), ...Array.from({ length: 4 }, (_, i) => result(`c${i}`, image(`${i + 2}${third}`)))];
  const seen: string[] = [];
  const trimmed = dropOldToolImages(messages, {
    locate: (message, index) => {
      seen.push(`${message.toolCallId}:${index}`);
      return `/saved/${message.toolCallId}-${index}.png`;
    },
  });
  assert.deepEqual(seen, ["a:0", "a:1", "c0:0", "c1:0"]);
  const notes = (trimmed as Array<{ content: Array<{ type: string; text?: string }> }>).slice(0, 1).flatMap((m) => m.content.filter((b) => b.text?.includes("saved at")));
  assert.match(notes[1].text ?? "", /saved at \/saved\/a-1\.png; read that file/);
});

test("with no saved copy the note says to regenerate instead", () => {
  const messages = Array.from({ length: 6 }, (_, i) => result(`c${i}`, image(`${i}${third}`)));
  assert.match(JSON.stringify(dropOldToolImages(messages)[0]), /Regenerate it/);
});
