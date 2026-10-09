import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelSocket, type DataChannelLike } from "../src/main/rtc/channel-socket.ts";
import { MAX_MESSAGE_BYTES } from "../src/main/rtc/frames.ts";

/**
 * The adapter between a data channel and the WebSocket-shaped socket the remote server
 * takes, driven by in-memory channels so no network is involved.
 */

class FakeChannel implements DataChannelLike {
  peer!: FakeChannel;
  open = true;
  /** What the "network" holds: the sender's buffer, drained by `flush`. */
  buffered = 0;
  stalled = false;
  failSend = false;
  closedByUs = false;
  sent: Buffer[] = [];
  #onMessage: (m: string | Buffer | ArrayBuffer) => void = () => undefined;
  #onClosed: () => void = () => undefined;
  #onLow: () => void = () => undefined;
  #onError: (e: string) => void = () => undefined;
  #low = 0;
  pending: Buffer[] = [];

  isOpen() { return this.open; }
  sendMessageBinary(message: Buffer) {
    // Like libdatachannel: `false` means "queued", and a dead channel is told by isOpen().
    if (this.failSend) this.open = false;
    if (!this.open) return false;
    this.sent.push(message);
    if (this.stalled) {
      this.pending.push(message);
      this.buffered += message.byteLength;
    } else {
      this.peer.deliver(message);
    }
    return true;
  }
  bufferedAmount() { return this.buffered; }
  setBufferedAmountLowThreshold(bytes: number) { this.#low = bytes; }
  onBufferedAmountLow(cb: () => void) { this.#onLow = cb; }
  onMessage(cb: (m: string | Buffer | ArrayBuffer) => void) { this.#onMessage = cb; }
  onClosed(cb: () => void) { this.#onClosed = cb; }
  onError(cb: (e: string) => void) { this.#onError = cb; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.closedByUs = true;
    queueMicrotask(() => { this.peer.open = false; this.peer.#onClosed(); });
  }
  deliver(message: Buffer) { queueMicrotask(() => this.#onMessage(message)); }
  /** Let the stalled network drain. */
  drain() {
    this.stalled = false;
    for (const message of this.pending.splice(0)) this.peer.deliver(message);
    this.buffered = 0;
    if (this.buffered <= this.#low) this.#onLow();
  }
  raiseError(text: string) { this.#onError(text); }
  injectRaw(message: string | Buffer) { this.deliver(message as Buffer); }
}

function pair() {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  const options = { maxFrameBytes: 32 * 1024 * 1024 };
  return { a, b, left: new ChannelSocket(a, options), right: new ChannelSocket(b, options) };
}

function once<T extends unknown[]>(socket: ChannelSocket, event: string): Promise<T> {
  return new Promise((settle) => socket.once(event, (...args) => settle(args as T)));
}

test("a text frame arrives whole, however large", async () => {
  const { left, right } = pair();
  const text = JSON.stringify({ kind: "result", blob: "é".repeat(3_000_000) });
  const received = once<[Buffer, boolean]>(right, "message");
  left.send(text);
  const [data, binary] = await received;
  assert.equal(binary, false);
  assert.equal(data.toString("utf8"), text);
});

test("a binary frame stays binary", async () => {
  const { left, right } = pair();
  const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256));
  const received = once<[Buffer, boolean]>(right, "message");
  left.send(bytes);
  const [data, binary] = await received;
  assert.equal(binary, true);
  assert.ok(data.equals(bytes));
});

test("no message exceeds the interoperable size", async () => {
  const { a, left } = pair();
  left.send("x".repeat(100_000));
  assert.ok(a.sent.length > 1);
  assert.ok(a.sent.every((m) => m.byteLength <= MAX_MESSAGE_BYTES));
});

test("ping is answered with a pong the sender sees", async () => {
  const { left } = pair();
  const pong = once(left, "pong");
  left.ping();
  await pong;
});

test("a close carries its code to the other side, and ends both", async () => {
  const { left, right } = pair();
  const closed = once<[number, Buffer]>(right, "close");
  left.close(4004, "backpressure");
  const [code, reason] = await closed;
  assert.equal(code, 4004);
  assert.equal(reason.toString(), "backpressure");
  assert.equal(left.readyState, 3);
  assert.equal(right.readyState, 3);
});

test("the channel dropping reports an abnormal close", async () => {
  const { a, right } = pair();
  const closed = once<[number]>(right, "close");
  a.close();
  const [code] = await closed;
  assert.equal(code, 1006);
});

test("a stalled network shows up as buffered bytes, and a callback only once it drains", async () => {
  const { a, left, right } = pair();
  a.stalled = true;
  // Fill the channel past the ceiling so that the rest of the frame has to wait in the queue.
  a.buffered = 300 * 1024;
  let done = 0;
  left.send("y".repeat(200_000), () => { done += 1; });
  assert.equal(done, 0, "the frame is still queued");
  assert.ok(left.bufferedAmount >= 200_000, `queued bytes count: ${left.bufferedAmount}`);

  const received = once<[Buffer, boolean]>(right, "message");
  a.drain();
  const [data] = await received;
  assert.equal(data.byteLength, 200_000);
  assert.equal(done, 1);
  assert.equal(left.bufferedAmount, 0);
});

test("a send that fails reports it and closes", async () => {
  const { a, left } = pair();
  const closed = once<[number]>(left, "close");
  a.failSend = true;
  const failed = new Promise<Error | undefined>((settle) => left.send("hello", (error) => settle(error)));
  assert.ok(await failed);
  await closed;
  assert.equal(left.readyState, 3);
});

test("what breaks the format ends the connection", async () => {
  const { b, left, right } = pair();
  const closed = once<[number, Buffer]>(right, "close");
  left.send("fine");
  await once(right, "message");
  b.injectRaw("a text message is not part of the format");
  const [code] = await closed;
  assert.equal(code, 1002);
});

test("sending on a closed socket fails through the callback", async () => {
  const { left } = pair();
  left.terminate();
  const error = await new Promise<Error | undefined>((settle) => left.send("late", (e) => settle(e)));
  assert.ok(error);
});

test("a send the channel reports as queued is not a failure", async () => {
  const { a, left, right } = pair();
  // libdatachannel answers false for a message it had to buffer; the channel stays open.
  const original = a.sendMessageBinary.bind(a);
  a.sendMessageBinary = (message: Buffer) => { original(message); return false; };
  const received = once<[Buffer, boolean]>(right, "message");
  left.send("still fine");
  const [data] = await received;
  assert.equal(data.toString(), "still fine");
  assert.equal(left.readyState, 1);
});
