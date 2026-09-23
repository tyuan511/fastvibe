import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MEMORY_CONFIG, memoryConfigOf } from "../src/shared/memory.ts";

test("memory config defaults to always-on model-free retrieval", () => {
  assert.deepEqual(memoryConfigOf(undefined), DEFAULT_MEMORY_CONFIG);
  assert.equal(DEFAULT_MEMORY_CONFIG.enabled, true);
  assert.equal(DEFAULT_MEMORY_CONFIG.mode, "default");
  assert.equal(DEFAULT_MEMORY_CONFIG.embeddingProvider, "local-minilm-multilingual-q8");
});

test("memory config sanitizes mode, limits and auto capture", () => {
  assert.deepEqual(memoryConfigOf({ enabled: true, mode: "jev", autoCapture: false, maxResults: 999, maxContextChars: 1 }), {
    enabled: true,
    mode: "jev",
    autoCapture: false,
    embeddingProvider: "local-minilm-multilingual-q8",
    maxResults: 32,
    maxContextChars: 1_000,
  });
  assert.equal(memoryConfigOf({ mode: "invalid" }).mode, "default");
  assert.equal(memoryConfigOf({ enabled: false, mode: "semantic" }).mode, "default");
});
