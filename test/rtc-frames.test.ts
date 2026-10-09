import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BINARY,
  FrameAssembler,
  FrameError,
  LAST,
  MAX_MESSAGE_BYTES,
  PING,
  PONG,
  closeMessage,
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
  assert.throws(() => assembler().push(Buffer.from([0x20, 1])), FrameError);
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
