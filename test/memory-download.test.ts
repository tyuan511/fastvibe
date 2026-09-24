import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddingDownloadBytes } from "../src/main/engine/memory-download.ts";

/** Byte sizes Hugging Face reports for paraphrase-multilingual-MiniLM-L12-v2. */
const FP32 = 470_301_610;
const INT8 = 118_412_398;
const TOKENIZER = 9_081_518;
const TOKENIZER_CONFIG = 526;
const CONFIG = 645;

const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);

test("embedding progress drops the fp32 file transformers.js prefetches but never downloads", () => {
  const bytes = embeddingDownloadBytes({
    "onnx/model.onnx": { loaded: 0, total: FP32 },
    "onnx/model_qint8_arm64.onnx": { loaded: 110_000_000, total: INT8 },
    "tokenizer.json": { loaded: TOKENIZER, total: TOKENIZER },
    "tokenizer_config.json": { loaded: TOKENIZER_CONFIG, total: TOKENIZER_CONFIG },
    "config.json": { loaded: CONFIG, total: CONFIG },
  }, "model_qint8_arm64");
  assert.ok(bytes);
  assert.equal(bytes.loaded, 110_000_000 + TOKENIZER + TOKENIZER_CONFIG + CONFIG);
  assert.equal(bytes.total, INT8 + TOKENIZER + TOKENIZER_CONFIG + CONFIG);
  // The library total is what the bar showed; the filtered total is the real download.
  assert.equal(mb(FP32 + bytes.total), "570.1");
  assert.equal(mb(bytes.total), "121.6");
});

test("embedding progress stays quiet until the real onnx file is reported", () => {
  assert.equal(embeddingDownloadBytes({
    "onnx/model.onnx": { loaded: 0, total: FP32 },
    "tokenizer.json": { loaded: TOKENIZER, total: TOKENIZER },
  }, "model_qint8_arm64"), undefined);
  assert.equal(embeddingDownloadBytes(undefined, "model_qint8_arm64"), undefined);
});

test("embedding progress keeps onnx/model.onnx when that is the file being fetched", () => {
  assert.deepEqual(embeddingDownloadBytes({
    "onnx/model.onnx": { loaded: 10, total: FP32 },
    "tokenizer.json": { loaded: TOKENIZER, total: TOKENIZER },
  }, "model"), {
    loaded: 10 + TOKENIZER,
    total: FP32 + TOKENIZER,
  });
});
