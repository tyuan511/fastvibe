import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  externalizeToolImages,
  linkToolImages,
  locateToolImage,
  MAX_REFERENCED_IMAGE_CHARS,
  referenceStoredToolImages,
  referenceToolResultImages,
  resolveToolImageRef,
  toolImagePath,
  ToolImageReader,
} from "../src/main/engine/tool-images.ts";
import { prepareRequestToolImages } from "../src/main/engine/context-images.ts";
import { isToolImageRef, toolImageRef, TOOL_IMAGE_REF_FIELD } from "../src/shared/tool-image-ref.ts";
import { toolImagesOf } from "../src/shared/tool-result.ts";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { summarizeToolCalls } from "../src/shared/tool-summary.ts";

const dir = () => mkdtempSync(join(tmpdir(), "fv-image-refs-"));
const b64 = (text: string) => Buffer.from(text).toString("base64");
const image = (text: string, mimeType = "image/jpeg") => ({ type: "image", data: b64(text), mimeType });
type Block = Record<string, unknown>;

test("a result's pictures become references to a written copy, and the text says where it is", () => {
  const root = dir();
  const content = referenceToolResultImages([{ type: "text", text: "shot" }, image("small copy")], root, "conv", "call-1");
  assert.ok(content);
  assert.deepEqual(content[0], { type: "text", text: "shot" });
  const ref = toolImageRef(content[1]);
  assert.deepEqual(ref, { folder: "conv", file: "model/call-1-0.jpg", mimeType: "image/jpeg", chars: b64("small copy").length, index: 0 });
  assert.equal(content[1].type, "text");
  const path = join(root, "conv", "model", "call-1-0.jpg");
  assert.equal(readFileSync(path, "utf8"), "small copy");
  assert.match(String(content[1].text), new RegExp(path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  // Already referenced: nothing left to do.
  assert.equal(referenceToolResultImages(content, root, "conv", "call-1"), undefined);
});

test("a picture too big to leave the SDK's normalization stays inline", () => {
  const root = dir();
  const huge = { type: "image", data: "A".repeat(MAX_REFERENCED_IMAGE_CHARS + 4), mimeType: "image/png" };
  assert.equal(referenceToolResultImages([huge], root, "conv", "c"), undefined);
});

test("the chat draws the full-size original behind a reference, else the model's copy, else nothing", () => {
  const root = dir();
  const content = referenceToolResultImages([image("model copy")], root, "conv", "c")!;
  // No original saved: the model's copy is what there is.
  const [onlyCopy] = externalizeToolImages(content, root, "conv", "c") as Block[];
  assert.equal(onlyCopy.path, join(root, "conv", "model", "c-0.jpg"));
  // With the original beside it (as `shrinkToolResultImages` saves it), that one is drawn.
  const original = toolImagePath(root, "conv", "c", 0, "image/png");
  writeAt(original, "full size");
  const [full] = externalizeToolImages(content, root, "conv", "c") as Block[];
  assert.deepEqual(full, { type: "image", mimeType: "image/png", path: original });
  // Files gone: the block is dropped, and its sentence is not output either.
  rmSync(join(root, "conv"), { recursive: true, force: true });
  assert.deepEqual(externalizeToolImages([{ type: "text", text: "ok" }, ...content], root, "conv", "c"), [{ type: "text", text: "ok" }]);
});

function writeAt(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("a reference cannot be pointed outside the pictures folder", () => {
  const ref = (folder: string, file: string) => ({ type: "text", text: "x", [TOOL_IMAGE_REF_FIELD]: { folder, file, mimeType: "image/png", chars: 1, index: 0 } });
  assert.ok(isToolImageRef(ref("conv", "model/c-0.png")));
  for (const [folder, file] of [["..", "model/c-0.png"], ["conv", "../c-0.png"], ["conv", "model/../../etc.png"], ["a/b", "model/c-0.png"], ["conv", "/etc/passwd"], [".hidden", "model/c-0.png"]]) {
    assert.equal(isToolImageRef(ref(folder, file)), false, `${folder} ${file}`);
  }
  assert.equal(isToolImageRef({ type: "text", text: "plain" }), false);
});

test("the projection shows a reference as the picture and never its sentence", () => {
  const root = dir();
  const content = referenceToolResultImages([{ type: "text", text: "captured" }, image("copy")], root, "conv", "c1")!;
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "screenshot", arguments: {} }], stopReason: "toolUse" };
  const result = { role: "toolResult", toolCallId: "c1", toolName: "screenshot", content, isError: false };
  // Desktop: Main resolves the reference to a file the chat reads.
  const desktop = mapEngineMessages([assistant, { ...result, content: externalizeToolImages(content, root, "conv", "c1") }], () => undefined);
  const tool = desktop[0].tools[0];
  assert.equal(tool.result, "captured");
  assert.equal(tool.images?.[0].path, join(root, "conv", "model", "c1-0.jpg"));
  // The compact phone transcript: no sentence either, and the picture is still counted.
  const phone = summarizeToolCalls(mapEngineMessages([assistant, result], () => undefined));
  assert.equal(phone[0].tools[0].result, "captured");
  assert.equal(toolImagesOf(content).length, 1);
  assert.equal(JSON.stringify(phone).includes("saved at"), false);
});

test("before a request the newest references come back as images, older ones as a note", async () => {
  const root = dir();
  const results = ["one", "two", "three"].map((text, n) => ({
    role: "toolResult",
    toolCallId: `c${n}`,
    content: referenceToolResultImages([image(text.repeat(400))], root, "conv", `c${n}`)!,
  }));
  const reader = new ToolImageReader();
  const prepared = await prepareRequestToolImages(results, {
    maxChars: b64("two".repeat(400)).length + b64("three".repeat(400)).length,
    locate: (message, index, block) => locateToolImage(root, "conv", String(message.toolCallId), index, block as Block),
    load: (ref) => reader.read(resolveToolImageRef(root, "conv", ref)),
  });
  const blocks = prepared.map((message) => (message.content as Block[])[0]);
  assert.equal(blocks[0].type, "text");
  assert.match(String(blocks[0].text), /left out of the context/);
  assert.match(String(blocks[0].text), /model\/c0-0\.jpg/);
  assert.deepEqual(blocks.slice(1).map((block) => [block.type, Buffer.from(String(block.data), "base64").toString()]), [
    ["image", "two".repeat(400)],
    ["image", "three".repeat(400)],
  ]);
  // The history it was given is untouched.
  assert.ok(isToolImageRef((results[1].content as Block[])[0]));
});

test("a reference whose file is gone tells the model so", async () => {
  const root = dir();
  const content = referenceToolResultImages([image("gone")], root, "conv", "c")!;
  rmSync(join(root, "conv"), { recursive: true, force: true });
  const [message] = await prepareRequestToolImages([{ role: "toolResult", toolCallId: "c", content }], {
    load: (ref) => new ToolImageReader().read(resolveToolImageRef(root, "conv", ref)),
  });
  const block = (message as { content: Block[] }).content[0];
  assert.equal(block.type, "text");
  assert.match(String(block.text), /no longer available/);
});

test("with no references and nothing over budget the request is left as it is", async () => {
  const messages = [{ role: "toolResult", toolCallId: "c", content: [image("inline")] }, { role: "user", content: "hi" }];
  const prepared = await prepareRequestToolImages(messages, { load: async () => assert.fail("nothing to load") });
  assert.equal(prepared, messages);
});

test("inline pictures and references share one budget, newest first", async () => {
  const root = dir();
  const old = { role: "toolResult", toolCallId: "a", content: [image("x".repeat(3000))] };
  const recent = { role: "toolResult", toolCallId: "b", content: referenceToolResultImages([image("y".repeat(3000))], root, "conv", "b")! };
  const prepared = await prepareRequestToolImages([old, recent], {
    maxChars: b64("y".repeat(3000)).length + 10,
    load: (ref) => new ToolImageReader().read(resolveToolImageRef(root, "conv", ref)),
  });
  const [first, second] = prepared.map((message) => (message as { content: Block[] }).content[0]);
  assert.equal(first.type, "text");
  assert.equal(second.type, "image");
});

test("an opened transcript's inline pictures are swapped for references in place", () => {
  const root = dir();
  const entries = [
    { type: "session", id: "s" },
    { type: "message", id: "u", message: { role: "user", content: [image("user attached")] } },
    { type: "message", id: "r", message: { role: "toolResult", toolCallId: "c", content: [image("tool picture")] } },
  ];
  assert.equal(referenceStoredToolImages(entries, root, "conv"), 1);
  const user = (entries[1] as { message: { content: Block[] } }).message.content[0];
  const tool = (entries[2] as { message: { content: Block[] } }).message.content[0];
  assert.equal(user.type, "image", "an image the user attached is theirs");
  assert.ok(isToolImageRef(tool));
  assert.equal(referenceStoredToolImages(entries, root, "conv"), 0);
});

test("a fork links the pictures it copied and keeps them after the source is deleted", () => {
  const root = dir();
  const content = referenceToolResultImages([image("forked")], root, "source", "c")!;
  writeAt(toolImagePath(root, "source", "c", 0, "image/png"), "original");
  referenceToolResultImages([image("not copied")], root, "source", "other");
  assert.equal(linkToolImages(root, "source", "fork", ["c"]), 2);
  assert.equal(existsSync(join(root, "fork", "model", "other-0.jpg")), false);
  const ref = toolImageRef(content[0])!;
  assert.equal(resolveToolImageRef(root, "fork", ref), join(root, "fork", "model", "c-0.jpg"));
  rmSync(join(root, "source"), { recursive: true, force: true });
  assert.equal(readFileSync(resolveToolImageRef(root, "fork", ref)!, "utf8"), "forked");
  const [drawn] = externalizeToolImages(content, root, "fork", "c") as Block[];
  assert.equal(drawn.path, join(root, "fork", "c-0.png"));
  assert.ok(statSync(String(drawn.path)).isFile());
});

test("the reader serves a picture from memory after the first read, within its bound", async () => {
  const root = dir();
  referenceToolResultImages([image("cached")], root, "conv", "c");
  const path = join(root, "conv", "model", "c-0.jpg");
  const reader = new ToolImageReader(64);
  const first = await reader.read(path);
  rmSync(path);
  assert.equal(await reader.read(path), first);
  assert.equal(await reader.read(join(root, "missing.jpg")), undefined);
  assert.equal(await reader.read(undefined), undefined);
});
