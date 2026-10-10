import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelSocket, type DataChannelLike } from "../src/main/rtc/channel-socket.ts";
import { DEFLATE, MAX_MESSAGE_BYTES } from "../src/main/rtc/frames.ts";

/**
 * The adapter between a data channel and the WebSocket-shaped socket the remote server
 * takes, driven by in-memory channels so no network is involved.
 */

class FakeChannel implements DataChannelLike {
  peer!: FakeChannel;
  open = true;
  /** What the peer negotiated. Absent until a test sets it. */
  maxMessageSize?: () => number;
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

test("a direct path sends larger fragments only when the peer negotiated them", async () => {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  a.maxMessageSize = () => 256 * 1024;
  const left = new ChannelSocket(a, { maxFrameBytes: 1 << 24 });
  const right = new ChannelSocket(b, { maxFrameBytes: 1 << 24 });
  const text = "z".repeat(200_000);
  const received = once<[Buffer, boolean]>(right, "message");

  left.send(text);
  assert.ok(a.sent.every((m) => m.byteLength <= MAX_MESSAGE_BYTES), "an unconfirmed path stays interoperable");
  assert.equal((await received)[0].toString(), text);

  a.sent = [];
  left.setCompress(false);
  const again = once<[Buffer, boolean]>(right, "message");
  left.send(text);
  assert.ok(a.sent.length < 8, `a direct path takes the peer's limit, not 16 KiB (${a.sent.length} fragments)`);
  assert.ok(a.sent.every((m) => m.byteLength <= 64 * 1024), "never past our own ceiling, whatever the peer claims");
  assert.equal((await again)[0].toString(), text);

  a.sent = [];
  left.setCompress(null);
  left.send(text);
  assert.ok(a.sent.every((m) => m.byteLength <= MAX_MESSAGE_BYTES), "losing the path returns to the interoperable size");
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

test("once the relay is confirmed, a large frame crosses compressed and arrives whole; a small one does not", async () => {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  const sender = new ChannelSocket(a, { maxFrameBytes: 1 << 24, compress: true });
  const receiver = new ChannelSocket(b, { maxFrameBytes: 1 << 24 });
  sender.setCompress(true);
  const got: string[] = [];
  const both = new Promise<void>((settle) => {
    receiver.on("message", (data: Buffer) => {
      got.push(data.toString("utf8"));
      if (got.length === 2) settle();
    });
  });
  const big = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, text: "lorem ipsum ".repeat(6) })) });
  sender.send(big);
  const wire = a.sent.reduce((n, m) => n + m.byteLength, 0);
  sender.send("tiny");
  await both;
  assert.ok(got[0] === big && got[1] === "tiny", "both frames arrive whole and in order");
  assert.ok(wire < Buffer.byteLength(big) / 3, `compressed on the wire (${wire} of ${Buffer.byteLength(big)})`);
  assert.equal(a.sent.at(-1)![0] & DEFLATE, 0, "the small frame is sent as it is");
});

test("without agreement nothing is compressed, so an older peer is never sent a header it refuses", () => {
  const { a, left } = pair();
  left.setCompress(true);
  left.send("x".repeat(50_000));
  assert.ok(a.sent.every((m) => (m[0] & DEFLATE) === 0));
});

test("compression follows the path: off until the relay is confirmed, then on, and off again when it leaves", async () => {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  const sender = new ChannelSocket(a, { maxFrameBytes: 1 << 24, compress: true });
  const receiver = new ChannelSocket(b, { maxFrameBytes: 1 << 24 });
  const big = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, text: "lorem ipsum ".repeat(6) })) });
  const take = (): Promise<string> => new Promise((settle) => receiver.once("message", (data: Buffer) => settle(data.toString("utf8"))));

  const direct = take();
  sender.send(big);
  assert.equal(await direct, big);
  assert.ok(a.sent.every((m) => (m[0] & DEFLATE) === 0), "an unconfirmed path is sent as it is");

  a.sent = [];
  sender.setCompress(null);
  const unknown = take();
  sender.send(big);
  assert.equal(await unknown, big);
  assert.ok(a.sent.every((m) => (m[0] & DEFLATE) === 0), "a path that is not known yet is not the relay");

  a.sent = [];
  sender.setCompress(true);
  const relayed = take();
  sender.send(big);
  assert.equal(await relayed, big);
  const wire = a.sent.reduce((n, m) => n + m.byteLength, 0);
  assert.ok(a.sent.every((m) => (m[0] & DEFLATE) !== 0) && wire < Buffer.byteLength(big) / 2, "the relay compresses");

  a.sent = [];
  sender.setCompress(false);
  const back = take();
  sender.send(big);
  assert.equal(await back, big);
  assert.ok(a.sent.every((m) => (m[0] & DEFLATE) === 0), "leaving the relay sends the next frame as it is");
});
