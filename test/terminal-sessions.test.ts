import { test } from "node:test";
import assert from "node:assert/strict";
import { createChunkDecoder } from "../src/main/engine/terminal-sessions.ts";

/**
 * The `script` / plain-child fallback hands over raw buffers: a pty read is whatever fit
 * the kernel buffer, so a 3-byte CJK character is split routinely under load. Decoding
 * each chunk on its own turns every split into U+FFFD — the other route to a garbled
 * terminal, on the platforms where node-pty did not build.
 */

const SAMPLE = "报告.txt done → 中文测试 🎉 café";

test("one decoder reassembles a stream split at any byte boundary", () => {
  const bytes = Buffer.from(SAMPLE, "utf8");
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const decode = createChunkDecoder();
    const out = `${decode(bytes.subarray(0, cut))}${decode(bytes.subarray(cut))}${decode(Buffer.alloc(0))}`;
    assert.equal(out, SAMPLE, `split at byte ${cut}`);
  }
});

test("per-chunk toString loses characters the decoder keeps", () => {
  const bytes = Buffer.from(SAMPLE, "utf8");
  // The first multi-byte character is 报 (e4 b8 a5…); splitting inside it is enough.
  const cut = bytes.indexOf(Buffer.from("文", "utf8")) + 1;
  const naive = `${bytes.subarray(0, cut).toString("utf8")}${bytes.subarray(cut).toString("utf8")}`;
  assert.notEqual(naive, SAMPLE);
  assert.match(naive, /\uFFFD/);

  const decode = createChunkDecoder();
  assert.equal(`${decode(bytes.subarray(0, cut))}${decode(bytes.subarray(cut))}`, SAMPLE);
});

test("a decoder holds an incomplete tail instead of emitting a replacement", () => {
  const decode = createChunkDecoder();
  const bytes = Buffer.from("中", "utf8");
  assert.equal(decode(bytes.subarray(0, 2)), "");
  assert.equal(decode(bytes.subarray(2)), "中");
});

test("decoders are independent", () => {
  const first = createChunkDecoder();
  const second = createChunkDecoder();
  const bytes = Buffer.from("中文", "utf8");
  // 中 = e4 b8 ad, 文 = e6 96 87: four bytes is 中 plus the first byte of 文.
  assert.equal(first(bytes.subarray(0, 4)), "中");
  // A second stream, fed whole characters, is untouched by the first's held byte.
  assert.equal(second(bytes.subarray(3)), "文");
  assert.equal(first(bytes.subarray(4)), "文");
});
