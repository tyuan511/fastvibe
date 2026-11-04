import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImageModel } from "../src/shared/image-generation.ts";
import { IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, imageDimensions, imageOptionsForResolution, imageRatios, imageResolution, imageResolutions } from "../src/shared/image-options.ts";
import { normalizeOpenAiOptions } from "../src/main/images/protocol.ts";

const model: ImageModel = { id: "custom/gpt-image-2.5-flare-1k", model: "gpt-image-2.5-flare-1k", name: "Images", protocol: "openai", baseUrl: "https://example.com/v1", hasKey: true, enabled: true };

test("every new GPT ratio and resolution preset fits endpoint limits and roundtrips without remapping", () => {
  for (const ratio of IMAGE_ASPECT_RATIOS) for (const resolution of IMAGE_RESOLUTIONS) {
    const dimensions = imageDimensions(ratio, resolution);
    assert.equal(dimensions.width % 16, 0);
    assert.equal(dimensions.height % 16, 0);
    assert.ok(Math.max(dimensions.width, dimensions.height) <= 3840);
    assert.ok(dimensions.width * dimensions.height >= 655360);
    assert.ok(dimensions.width * dimensions.height <= 8294400);
    const options = imageOptionsForResolution(model, { count: 3 }, ratio, resolution);
    assert.deepEqual(normalizeOpenAiOptions(options, model), options);
    assert.equal(imageResolution(options), resolution);
    assert.equal(options.count, 3);
  }
});

test("legacy GPT size enum and Gemini/Grok native resolution formats stay separate", () => {
  const legacy = { ...model, model: "gpt-image-1.5" };
  assert.deepEqual(imageRatios(legacy), ["1:1", "3:2", "2:3"]);
  assert.deepEqual(imageResolutions(legacy), ["1K"]);
  assert.equal(imageOptionsForResolution(legacy, {}, "3:2", "1K").size, "1536x1024");
  assert.throws(() => normalizeOpenAiOptions({ aspectRatio: "16:9" }, legacy));
  assert.deepEqual(imageRatios(model), [...IMAGE_ASPECT_RATIOS]);
  assert.deepEqual(imageResolutions({ ...model, protocol: "grok" }), ["1K", "2K"]);
  assert.equal(imageOptionsForResolution({ ...model, protocol: "grok" }, {}, "21:9", "2K").size, "2K");
  assert.equal(imageOptionsForResolution({ ...model, protocol: "gemini" }, {}, "9:16", "4K").size, "4K");
});

test("custom GPT dimensions reject invalid, oversized and ratio-conflicting requests", () => {
  for (const options of [{ size: "2K" }, { size: "1920x1080" }, { size: "4096x4096" }, { size: "512x512" }, { size: "3840x3840" }, { size: "3072x768" }, { size: "1536x1024", aspectRatio: "1:1" }]) {
    assert.throws(() => normalizeOpenAiOptions(options, model));
  }
  assert.equal(normalizeOpenAiOptions({ size: "1536x864", aspectRatio: "16:9" }, model).size, "1536x864");
});
