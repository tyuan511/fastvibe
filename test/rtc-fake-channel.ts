import type { DataChannelLike } from "../src/main/rtc/channel-socket.ts";

/**
 * Two in-memory data channels wired to each other, standing in for a real peer
 * connection in tests. Delivery is asynchronous, as it is on a real channel.
 */
export class FakeChannel implements DataChannelLike {
  peer!: FakeChannel;
  open = true;
  /** The far end has stopped reading: nothing it is sent is delivered. */
  muted = false;
  #onMessage: (m: string | Buffer | ArrayBuffer) => void = () => undefined;
  #onClosed: () => void = () => undefined;

  isOpen() { return this.open; }
  sendMessageBinary(message: Buffer) {
    if (!this.open) return false;
    const copy = Buffer.from(message);
    queueMicrotask(() => { if (!this.peer.muted && this.peer.open) this.peer.#onMessage(copy); });
    return true;
  }
  bufferedAmount() { return 0; }
  setBufferedAmountLowThreshold() { /* nothing is ever buffered */ }
  onBufferedAmountLow() { /* nothing is ever buffered */ }
  onMessage(cb: (m: string | Buffer | ArrayBuffer) => void) { this.#onMessage = cb; }
  onClosed(cb: () => void) { this.#onClosed = cb; }
  onError() { /* never errors */ }
  close() {
    if (!this.open) return;
    this.open = false;
    queueMicrotask(() => { this.peer.open = false; this.peer.#onClosed(); });
  }
}

export const FakeChannelPair = {
  create() {
    const a = new FakeChannel();
    const b = new FakeChannel();
    a.peer = b;
    b.peer = a;
    return { a, b };
  },
};
