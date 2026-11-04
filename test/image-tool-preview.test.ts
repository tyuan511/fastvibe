import { test } from "node:test";
import assert from "node:assert/strict";
import { imagePreviewFromTool } from "../src/renderer/src/lib/image-tool.ts";
import type { ImageGenerationPreview } from "../src/renderer/src/lib/image-tool.ts";
import type { ToolCallBlock } from "../src/shared/types.ts";

const call = (patch: Partial<ToolCallBlock> = {}): ToolCallBlock => ({ id: "call", name: "generate_image", status: "running", ...patch });
const image = (index: number) => ({ id: `image-${index}`, index, path: `/images/${index}.png`, mimeType: "image/png", width: 1024, height: 768 });

test("four requested outputs project prompt and options without allocating pending images", () => {
  const preview: ImageGenerationPreview = imagePreviewFromTool(call({ args: { prompt: "四只猫", aspect_ratio: "4:3", size: "1024x768", count: 4 } }));
  assert.deepEqual(preview, { id: "call", prompt: "四只猫", options: { aspectRatio: "4:3", size: "1024x768", count: 4 }, images: [], status: "generating" });
});

test("count defaults to one, rejects nonfinite/nonnumber values and clamps finite numbers", () => {
  for (const count of [undefined, null, NaN, Infinity, -Infinity, "4", {}, [], true]) {
    assert.equal(imagePreviewFromTool(call({ args: { count } })).options.count, 1);
  }
  for (const [count, expected] of [[0, 1], [-100, 1], [2.9, 2], [4, 4], [1e100, 4]]) {
    assert.equal(imagePreviewFromTool(call({ args: { count } })).options.count, expected);
  }
  assert.equal(imagePreviewFromTool(call()).options.count, 1);
});

test("incremental and reverse completions preserve stable image indexes and metadata", () => {
  for (const indexes of [[3], [3, 1], [3, 1, 2, 0]]) {
    const images = indexes.map(image);
    const tool = call({ args: { count: 4 }, details: { task: { id: "task", status: "generating", options: { count: 4 }, images } } });
    const before = structuredClone(tool);
    const preview = imagePreviewFromTool(tool);
    assert.deepEqual(preview.images, images);
    assert.equal(preview.status, "generating");
    assert.deepEqual(tool, before);
    assert.notEqual(preview.images[0], images[0]);
  }
});

test("task snapshot takes precedence over args and both legacy image sources", () => {
  const preview = imagePreviewFromTool(call({
    args: { prompt: "old", count: 1, aspect_ratio: "1:1", size: "old" },
    details: { task: { id: "task", prompt: "new", options: { count: 4, aspectRatio: "16:9", size: "large", quality: "high" }, status: "partial", images: [image(2)] }, items: [{ ref: "/old.png" }] },
    result: JSON.stringify({ taskId: "old", images: [image(0)] }),
  }));
  assert.equal(preview.id, "task");
  assert.equal(preview.prompt, "new");
  assert.deepEqual(preview.options, { count: 4, aspectRatio: "16:9", size: "large", quality: "high" });
  assert.deepEqual(preview.images, [image(2)]);
  assert.equal(preview.status, "partial");
  assert.deepEqual(imagePreviewFromTool(call({ details: { task: { images: [] }, items: [{ ref: "/old.png" }] } })).images, []);
});

test("legacy JSON results restore image paths and metadata", () => {
  const preview = imagePreviewFromTool(call({ status: "done", result: JSON.stringify({ taskId: "legacy", images: [image(0), image(1)] }) }));
  assert.equal(preview.id, "legacy");
  assert.equal(preview.status, "succeeded");
  assert.deepEqual(preview.images, [image(0), image(1)]);
});

test("legacy items take precedence, skip failures and can fall back to JSON", () => {
  const preview = imagePreviewFromTool(call({ status: "done", details: { taskId: "legacy", items: [null, { ref: "/failed.png", ok: false }, { ref: " " }, { ref: "/saved.png", ok: true }] }, result: JSON.stringify({ images: [image(0)] }) }));
  assert.deepEqual(preview.images, [{ id: "legacy:3", path: "/saved.png", mimeType: "image/png" }]);
  assert.equal(preview.status, "succeeded");
  assert.deepEqual(imagePreviewFromTool(call({ details: { items: [null] }, result: JSON.stringify({ images: [image(1)] }) })).images, [image(1)]);
});

test("tool errors terminate stale generating snapshots with partial or failed status", () => {
  for (const images of [[], [image(3)]]) {
    const preview = imagePreviewFromTool(call({ status: "error", details: { task: { status: "generating", images } } }));
    assert.equal(preview.status, images.length ? "partial" : "failed");
  }
  assert.equal(imagePreviewFromTool(call({ status: "error", details: { task: { status: "succeeded", images: [] } } })).status, "failed");
  assert.equal(imagePreviewFromTool(call({ status: "aborted", details: { task: { status: "generating", images: [image(1)] } } })).status, "cancelled");
});

test("cancelled tasks retain completed images when the tool ends with an error or success", () => {
  for (const status of ["error", "done"] as const) {
    for (const images of [[], [image(3)]]) {
      const preview = imagePreviewFromTool(call({ status, details: { task: { status: "cancelled", images } } }));
      assert.equal(preview.status, "cancelled");
      assert.deepEqual(preview.images, images);
    }
  }
});

test("restart interruptions preserve their outcome and images; explicit abort remains cancelled", () => {
  for (const status of ["error", "done", "aborted"] as const) {
    for (const images of [[], [image(2)]]) {
      const preview = imagePreviewFromTool(call({ status, details: { task: { status: "interrupted", images } } }));
      assert.equal(preview.status, status === "aborted" ? "cancelled" : "interrupted");
      assert.deepEqual(preview.images, images);
    }
  }
});

test("legacy JSON terminal status is a fallback and never keeps a settled tool generating", () => {
  for (const status of ["error", "done"] as const) {
    for (const outcome of ["cancelled", "interrupted"]) {
      for (const images of [[], [image(1)]]) {
        const result = JSON.stringify({ status: outcome, images });
        const preview = imagePreviewFromTool(call({ status, result }));
        assert.equal(preview.status, outcome);
        assert.deepEqual(preview.images, images);
        assert.equal(imagePreviewFromTool(call({ status, result, details: { task: { status: "generating" } } })).status, outcome);
        assert.equal(imagePreviewFromTool(call({ status: "aborted", result })).status, "cancelled");
      }
    }
  }
  assert.equal(imagePreviewFromTool(call({ status: "done", details: { task: { status: "partial" } }, result: JSON.stringify({ status: "cancelled" }) })).status, "partial");
  for (const outcome of ["succeeded", "partial", "failed"]) {
    assert.equal(imagePreviewFromTool(call({ status: "done", result: JSON.stringify({ status: outcome }) })).status, outcome);
  }
  for (const outcome of ["generating", "unknown", null, [], {}]) {
    assert.equal(imagePreviewFromTool(call({ status: "done", result: JSON.stringify({ status: outcome }) })).status, "failed");
  }
});

test("done honors legal terminal task status and otherwise derives a terminal outcome", () => {
  for (const status of ["succeeded", "partial", "failed", "cancelled", "interrupted"]) {
    assert.equal(imagePreviewFromTool(call({ status: "done", details: { task: { status, images: [] } } })).status, status);
  }
  for (const status of [undefined, "generating", "unknown", [], {}]) {
    for (const images of [[], [image(0)]]) {
      assert.equal(imagePreviewFromTool(call({ status: "done", details: { task: { status, images } } })).status, images.length ? "succeeded" : "failed");
    }
  }
});

test("malformed payloads are safe, including null, arrays, primitives and non-JSON results", () => {
  for (const value of [null, [], [image(0)], "text", 42, true]) {
    assert.doesNotThrow(() => imagePreviewFromTool(call({ args: value, details: value })));
    assert.doesNotThrow(() => imagePreviewFromTool(call({ details: { task: value, items: value }, result: JSON.stringify(value) })));
    assert.doesNotThrow(() => imagePreviewFromTool(call({ details: { task: { images: value, options: value } } })));
  }
  for (const result of [undefined, "", "Generating images…", "{", "null", "[]", "123"]) {
    assert.equal(imagePreviewFromTool(call({ status: "done", result })).status, "failed");
  }
});

test("only nonempty paths survive; invalid metadata is omitted and images are capped at four", () => {
  const images = [null, [], false, { path: null }, { path: 1 }, { path: "" }, { path: "  " },
    { path: "/valid.webp", index: Infinity, id: null, mimeType: [], width: NaN, height: -1 },
    ...Array.from({ length: 8 }, (_, index) => image(index))];
  const preview = imagePreviewFromTool(call({ details: { task: { images, options: { count: Infinity } } }, args: { count: 4 } }));
  assert.equal(preview.images.length, 4);
  assert.deepEqual(preview.images[0], { id: "call:7", path: "/valid.webp", mimeType: "image/png" });
  assert.equal(preview.options.count, 4);
  for (const index of [-1, 4, 1.5, NaN, "2"]) {
    assert.equal(imagePreviewFromTool(call({ details: { task: { images: [{ ...image(0), index }] } } })).images[0].index, undefined);
  }
});
