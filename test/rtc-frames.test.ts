import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  BINARY,
  COMPRESS_MIN_BYTES,
  DEFLATE,
  DIRECT_MAX_MESSAGE_BYTES,
  FrameAssembler,
  FrameError,
  LAST,
  MAX_MESSAGE_BYTES,
  PING,
  PONG,
  closeMessage,
  compressFrame,
  controlMessage,
  splitFrame,
} from "../src/main/rtc/frames.ts";

/**
 * The wire format between the desktop and the phone. The phone's copy
 * (`rtc_frames.dart`) is tested against the same bytes, so a change here that is not
 * mirrored there fails in one of the two suites.
 */

function roundTrip(data: Buffer, binary: boolean) {
  const assembler = new FrameAssembler(32 * 1024 * 1024);
  let result;
  for (const message of splitFrame(data, binary)) {
    assert.ok(message.byteLength <= MAX_MESSAGE_BYTES, "a fragment must fit the interoperable size");
    result = assembler.push(message);
  }
  return result;
}

test("a small frame is one fragment, marked last", () => {
  const messages = splitFrame(Buffer.from("hi"), false);
  assert.equal(messages.length, 1);
  assert.deepEqual([...messages[0]], [LAST, 0x68, 0x69]);
});

test("the binary flag rides on every fragment", () => {
  const messages = splitFrame(Buffer.alloc(MAX_MESSAGE_BYTES * 2 + 5, 7), true);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m[0]), [BINARY, BINARY, BINARY | LAST]);
});

test("a direct path's larger limit still round-trips, and stays within it", () => {
  const data = Buffer.alloc(DIRECT_MAX_MESSAGE_BYTES * 2 + 10);
  for (let i = 0; i < data.byteLength; i += 1) data[i] = i % 251;
  const messages = splitFrame(data, false, false, DIRECT_MAX_MESSAGE_BYTES);
  assert.equal(messages.length, 3, "four times fewer fragments than the interoperable size");
  assert.ok(messages.every((message) => message.byteLength <= DIRECT_MAX_MESSAGE_BYTES));
  const assembler = new FrameAssembler(8 * 1024 * 1024);
  let result;
  for (const message of messages) result = assembler.push(message);
  assert.equal(result?.kind, "frame");
  if (result?.kind === "frame") assert.ok(result.data.equals(data));
});

test("frames of every size survive the split", () => {
  for (const size of [0, 1, MAX_MESSAGE_BYTES - 2, MAX_MESSAGE_BYTES - 1, MAX_MESSAGE_BYTES, 3 * MAX_MESSAGE_BYTES, 1_000_003]) {
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) data[i] = i % 251;
    for (const binary of [false, true]) {
      const out = roundTrip(data, binary);
      assert.equal(out?.kind, "frame", `size ${size}`);
      if (out?.kind !== "frame") continue;
      assert.equal(out.binary, binary);
      assert.ok(out.data.equals(data), `size ${size}`);
    }
  }
});

test("a frame is not delivered until its last fragment", () => {
  const assembler = new FrameAssembler(1 << 20);
  const [first, second] = splitFrame(Buffer.alloc(MAX_MESSAGE_BYTES), false);
  assert.equal(assembler.push(first).kind, "partial");
  assert.equal(assembler.push(second).kind, "frame");
});

test("controls may fall between the fragments of a frame", () => {
  const assembler = new FrameAssembler(1 << 20);
  const [first, second] = splitFrame(Buffer.alloc(MAX_MESSAGE_BYTES), false);
  assembler.push(first);
  assert.equal(assembler.push(controlMessage(PING)).kind, "ping");
  assert.equal(assembler.push(controlMessage(PONG)).kind, "pong");
  const out = assembler.push(second);
  assert.equal(out.kind, "frame");
  assert.equal(out.kind === "frame" && out.data.byteLength, MAX_MESSAGE_BYTES);
});

test("a close message carries its code and reason", () => {
  const assembler = new FrameAssembler(1 << 20);
  assert.deepEqual(assembler.push(closeMessage(4004, "backpressure")), { kind: "close", code: 4004, reason: "backpressure" });
  assert.deepEqual(assembler.push(closeMessage(1000)), { kind: "close", code: 1000, reason: "" });
});

test("what the format does not allow is refused", () => {
  const assembler = () => new FrameAssembler(1 << 20);
  assert.throws(() => assembler().push(Buffer.alloc(0)), FrameError);
  assert.throws(() => assembler().push(Buffer.from([0x40, 1])), FrameError);
  assert.throws(() => assembler().push(Buffer.from([0x10, 0])), FrameError);
  const mixed = assembler();
  mixed.push(Buffer.from([0x00, 1]));
  assert.throws(() => mixed.push(Buffer.from([BINARY | LAST, 1])), FrameError);
});

test("a frame past the limit is refused while it is still arriving", () => {
  const assembler = new FrameAssembler(MAX_MESSAGE_BYTES);
  const [first, second] = splitFrame(Buffer.alloc(MAX_MESSAGE_BYTES + 100), false);
  assembler.push(first);
  assert.throws(() => assembler.push(second), FrameError);
});

test("the bytes are the contract", () => {
  // Pinned so the Dart side can assert the very same arrays.
  assert.deepEqual([...splitFrame(Buffer.from('{"a":1}'), false)[0]], [1, 123, 34, 97, 34, 58, 49, 125]);
  assert.deepEqual([...controlMessage(PING)], [4]);
  assert.deepEqual([...controlMessage(PONG)], [8]);
  assert.deepEqual([...closeMessage(4001, "no")], [16, 15, 161, 110, 111]);
});

test("a compressed frame survives the split and comes back inflated", () => {
  const data = Buffer.from(JSON.stringify({ messages: Array.from({ length: 400 }, (_, i) => ({ id: i, text: "hello world ".repeat(8) })) }));
  const packed = compressFrame(data);
  assert.ok(packed && packed.byteLength < data.byteLength / 4, "JSON compresses well");
  const assembler = new FrameAssembler(32 * 1024 * 1024);
  const messages = splitFrame(packed, false, true);
  assert.ok(messages.every((m) => (m[0] & DEFLATE) !== 0), "every fragment says so");
  let out;
  for (const message of messages) out = assembler.push(message);
  assert.equal(out?.kind, "frame");
  if (out?.kind === "frame") {
    assert.ok(out.data.equals(data));
    assert.equal(out.binary, false);
  }
});

test("a frame too short, or that does not shrink, is not compressed", () => {
  assert.equal(compressFrame(Buffer.from("short")), null);
  const noise = randomBytes(COMPRESS_MIN_BYTES * 4);
  assert.equal(compressFrame(noise), null);
});

test("a compressed frame cannot inflate past the frame limit", () => {
  const bomb = deflateRawSync(Buffer.alloc(4 * 1024 * 1024));
  assert.ok(bomb.byteLength < 8 * 1024);
  const assembler = new FrameAssembler(1024 * 1024);
  assert.throws(() => assembler.push(splitFrame(bomb, false, true)[0]), FrameError);
});

test("garbage marked compressed, and mixed fragments, are refused", () => {
  const assembler = new FrameAssembler(1 << 20);
  assert.throws(() => assembler.push(Buffer.from([LAST | DEFLATE, 0x07, 0xff, 0xff])), FrameError);
  const second = new FrameAssembler(1 << 20);
  second.push(Buffer.concat([Buffer.from([DEFLATE]), Buffer.alloc(10)]));
  assert.throws(() => second.push(Buffer.concat([Buffer.from([LAST]), Buffer.alloc(4)])), FrameError);
});
