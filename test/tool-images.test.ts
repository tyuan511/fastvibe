import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalizeToolEndEvent, externalizeToolResultMessages, shrinkToolResultImages, toolImagePath } from "../src/main/engine/tool-images.ts";
import { toolImagesOf } from "../src/shared/tool-result.ts";

const PNG = Buffer.from("not really a png").toString("base64");
const dir = () => mkdtempSync(join(tmpdir(), "fv-tool-images-"));
const result = (id: string, ...content: unknown[]) => ({ role: "toolResult", toolCallId: id, content });

test("a result's picture is written once and the block carries only its path", () => {
  const root = dir();
  const [out] = externalizeToolResultMessages([result("call-1", { type: "text", text: "ok" }, { type: "image", data: PNG, mimeType: "image/png" })], root, "conv");
  const blocks = (out as { content: Array<Record<string, unknown>> }).content;
  assert.equal(blocks[0].type, "text");
  assert.deepEqual(Object.keys(blocks[1]).sort(), ["mimeType", "path", "type"]);
  const path = blocks[1].path as string;
  assert.equal(path, toolImagePath(root, "conv", "call-1", 0, "image/png"));
  assert.equal(readFileSync(path, "utf8"), "not really a png");
});

test("doing it again reuses the file and gives the same path", () => {
  const root = dir();
  const message = result("call-1", { type: "image", data: PNG, mimeType: "image/jpeg" });
  const first = externalizeToolResultMessages([message], root, "conv")[0] as { content: Array<{ path: string }> };
  const second = externalizeToolResultMessages([message], root, "conv")[0] as { content: Array<{ path: string }> };
  assert.equal(first.content[0].path, second.content[0].path);
  assert.match(first.content[0].path, /call-1-0\.jpg$/);
  assert.deepEqual(readdirSync(join(root, "conv")), ["call-1-0.jpg"]);
});

test("several pictures in one result get their own files", () => {
  const root = dir();
  const [out] = externalizeToolResultMessages([result("c", { type: "image", data: PNG, mimeType: "image/png" }, { type: "image", data: PNG, mimeType: "image/webp" })], root, "conv");
  assert.deepEqual((out as { content: Array<{ path: string }> }).content.map((b) => b.path.split("/").pop()), ["c-0.png", "c-1.webp"]);
});

test("messages without pictures come back as the same objects", () => {
  const root = dir();
  const plain = result("a", { type: "text", text: "hi" });
  const user = { role: "user", content: "hello" };
  const out = externalizeToolResultMessages([user, plain], root, "conv");
  assert.equal(out[0], user);
  assert.equal(out[1], plain);
  assert.equal(existsSync(join(root, "conv")), false);
});

test("an id cannot climb out of the folder", () => {
  const path = toolImagePath("/data", "../../etc", "../x", 0, "image/png");
  assert.ok(path.startsWith("/data/"));
  assert.ok(!path.split("/").includes(".."));
  assert.equal(path.split("/").length, 4);
});

test("a picture that cannot be written stays as it was", () => {
  const out = externalizeToolResultMessages([result("c", { type: "image", data: PNG, mimeType: "image/png" })], "/dev/null/nope", "conv")[0] as { content: Array<Record<string, unknown>> };
  assert.equal(out.content[0].data, PNG);
});

test("a live tool_execution_end is rewritten, other events are not", () => {
  const root = dir();
  const end = { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "image", data: PNG, mimeType: "image/png" }], details: { a: 1 } } };
  const out = externalizeToolEndEvent(end, root, "conv") as typeof end;
  assert.equal((out.result.content[0] as Record<string, unknown>).data, undefined);
  assert.deepEqual(out.result.details, { a: 1 });
  const other = { type: "message_end" };
  assert.equal(externalizeToolEndEvent(other, root, "conv"), other);
});

test("the client side reads a path block as a path and no bytes", () => {
  assert.deepEqual(toolImagesOf([{ type: "image", mimeType: "image/png", path: "/x/a.png" }]), [{ mimeType: "image/png", path: "/x/a.png" }]);
  assert.equal(toolImagesOf([{ type: "image", data: PNG, mimeType: "image/png" }])[0].dataUrl?.startsWith("data:image/png;base64,"), true);
});

test("a result's pictures are saved in full and the history keeps the smaller copy", async () => {
  const root = dir();
  const resize = async () => ({ data: Buffer.from("tiny").toString("base64"), mimeType: "image/jpeg" });
  const content = [{ type: "text", text: "ok" }, { type: "image", data: PNG, mimeType: "image/png" }];
  const shrunk = (await shrinkToolResultImages(content, root, "conv", "c1", resize))!;
  assert.deepEqual(shrunk[0], content[0]);
  assert.deepEqual(shrunk[1], { type: "image", data: Buffer.from("tiny").toString("base64"), mimeType: "image/jpeg" });
  assert.equal(readFileSync(join(root, "conv", "c1-0.png"), "utf8"), "not really a png");
});

test("the transcript then points at the full-size file, though its own picture is a JPEG", async () => {
  const root = dir();
  const resize = async () => ({ data: Buffer.from("tiny").toString("base64"), mimeType: "image/jpeg" });
  const shrunk = (await shrinkToolResultImages([{ type: "image", data: PNG, mimeType: "image/png" }], root, "conv", "c1", resize))!;
  const [out] = externalizeToolResultMessages([{ role: "toolResult", toolCallId: "c1", content: shrunk }], root, "conv");
  const block = (out as { content: Array<{ path: string; mimeType: string }> }).content[0];
  assert.equal(block.path, join(root, "conv", "c1-0.png"));
  assert.equal(block.mimeType, "image/png");
  assert.deepEqual(readdirSync(join(root, "conv")), ["c1-0.png"]);
});

test("a picture the resizer cannot make smaller, or fails on, stays as it was", async () => {
  const root = dir();
  const content = [{ type: "image", data: PNG, mimeType: "image/png" }];
  assert.equal(await shrinkToolResultImages(content, root, "conv", "a", async () => null), undefined);
  assert.equal(await shrinkToolResultImages(content, root, "conv", "b", async () => { throw new Error("no decoder"); }), undefined);
  assert.equal(await shrinkToolResultImages(content, root, "conv", "c", async () => ({ data: PNG + PNG, mimeType: "image/jpeg" })), undefined);
  assert.equal(await shrinkToolResultImages([{ type: "text", text: "x" }], root, "conv", "d", async () => null), undefined);
});
