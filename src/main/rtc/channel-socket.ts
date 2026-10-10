import { EventEmitter } from "node:events";
import {
  DIRECT_MAX_MESSAGE_BYTES,
  FrameAssembler,
  FrameError,
  MAX_MESSAGE_BYTES,
  PING,
  PONG,
  closeMessage,
  compressFrame,
  controlMessage,
  splitFrame,
} from "./frames.ts";
import type { RemoteSocket } from "../server/server.ts";

/**
 * The part of a node-datachannel `DataChannel` this adapter drives. A fake stands in for
 * it in the tests, so none of them needs a network.
 */
export interface DataChannelLike {
  isOpen(): boolean;
  /**
   * libdatachannel answers `true` when the message went out at once and `false` when it
   * was queued behind others — which is not a failure. A send fails when the channel is
   * no longer open (or throws).
   */
  sendMessageBinary(message: Buffer): boolean;
  bufferedAmount(): number;
  /** The largest message this channel will accept, once negotiated. Absent on a fake. */
  maxMessageSize?(): number;
  setBufferedAmountLowThreshold(bytes: number): void;
  onBufferedAmountLow(callback: () => void): void;
  onMessage(callback: (message: string | Buffer | ArrayBuffer) => void): void;
  onClosed(callback: () => void): void;
  onError(callback: (error: string) => void): void;
  close(): void;
}

/** Stop handing fragments to the channel above this much queued inside it. */
const HIGH_WATER_BYTES = 256 * 1024;
const LOW_WATER_BYTES = 64 * 1024;

/** WebSocket close codes this adapter reports, for the callers that branch on them. */
const CLOSE_NORMAL = 1000;
const CLOSE_ABNORMAL = 1006;
const CLOSE_PROTOCOL = 1002;

type Outgoing = { message: Buffer; done?: (error?: Error) => void };

/**
 * A data channel dressed as the WebSocket the remote server expects.
 *
 * `RemoteServer.attachTransport` takes anything shaped like `RemoteSocket`, and this is
 * what makes a WebRTC connection one: whole frames in and out (fragmented per
 * `frames.ts`), `ping`/`pong` that mean what they mean on a WebSocket, a `bufferedAmount`
 * the backpressure guard can judge, and a `close` that carries a code.
 *
 * Sending is a queue that is drained into the channel only while the channel's own buffer
 * is below a ceiling. A data channel will otherwise accept megabytes at once and report
 * the cost nowhere, and the server's guard has to see a stalled phone *as* a growing
 * `bufferedAmount` to close it: so the queue counts toward it.
 */
export class ChannelSocket extends EventEmitter implements RemoteSocket {
  readonly OPEN = 1;
  readonly #channel: DataChannelLike;
  readonly #assembler: FrameAssembler;
  #state: 0 | 1 | 2 | 3;
  #queue: Outgoing[] = [];
  #queuedBytes = 0;
  #closed = false;
  /**
   * The peer reads compressed frames (it said so while the call was being set up).
   *
   * Permission only. Compression runs on this thread and pays for itself on the relay,
   * where a phone is hundreds of milliseconds away; on a direct path the CPU costs more
   * than the bytes. The path is not known when the channel opens — ICE nominates after —
   * so a frame leaves as it is until the path is reported as the relay, and a later change
   * applies to the next frame. The bit rides each fragment, so the two can mix.
   */
  readonly #compressAllowed: boolean;
  #compress = false;
  /** Direct-path fragments grow to this, and only when the peer negotiated it. */
  #direct = false;
  #maxMessageBytes = MAX_MESSAGE_BYTES;

  constructor(channel: DataChannelLike, options: { maxFrameBytes: number; compress?: boolean }) {
    super();
    this.#channel = channel;
    this.#compressAllowed = options.compress === true;
    this.#assembler = new FrameAssembler(options.maxFrameBytes);
    this.#state = channel.isOpen() ? 1 : 0;
    channel.setBufferedAmountLowThreshold(LOW_WATER_BYTES);
    channel.onBufferedAmountLow(() => this.#pump());
    channel.onMessage((message) => this.#receive(message));
    channel.onClosed(() => this.#finish(CLOSE_ABNORMAL, ""));
    channel.onError((error) => {
      // An error on a data channel is followed by its close; report it, let the close end it.
      this.emit("error", new Error(error));
    });
  }

  get readyState(): number {
    return this.#state;
  }

  get bufferedAmount(): number {
    return this.#queuedBytes + (this.#closed ? 0 : this.#channel.bufferedAmount());
  }

  send(data: string | Uint8Array, callback?: (error?: Error) => void): void {
    if (this.#state !== 1) {
      const error = new Error("data channel is not open");
      if (callback) callback(error);
      else throw error;
      return;
    }
    const binary = typeof data !== "string";
    const bytes = binary ? data : Buffer.from(data, "utf8");
    const packed = this.#compress ? compressFrame(bytes) : null;
    const limit = this.#fragmentLimit();
    const fragments = packed ? splitFrame(packed, binary, true, limit) : splitFrame(bytes, binary, false, limit);
    fragments.forEach((message, index) => {
      this.#queue.push({ message, done: index === fragments.length - 1 ? callback : undefined });
      this.#queuedBytes += message.byteLength;
    });
    this.#pump();
  }

  /**
   * Whether the next frame should be compressed. `null` (the path is not known yet) and
   * `false` (it is direct) both send frames as they are; only a confirmed relay enables it,
   * and only when the peer agreed to read compressed frames.
   */
  setCompress(compress: boolean | null): void {
    this.#compress = this.#compressAllowed && compress === true;
    // A direct path is the one that can afford fewer, larger fragments. The relay stays
    // at the interoperable size: a lossy hop is where a large SCTP message costs retries.
    this.#direct = compress === false;
  }

  /**
   * How large one fragment may be. The interoperable size unless the path is direct
   * *and* the open channel reports the peer accepted more — never past our own ceiling,
   * and never on a number the peer did not negotiate.
   */
  #fragmentLimit(): number {
    if (!this.#direct) return MAX_MESSAGE_BYTES;
    if (this.#maxMessageBytes > MAX_MESSAGE_BYTES) return this.#maxMessageBytes;
    const reported = this.#channel.maxMessageSize?.();
    if (typeof reported === "number" && Number.isFinite(reported) && reported > MAX_MESSAGE_BYTES) {
      this.#maxMessageBytes = Math.min(Math.floor(reported), DIRECT_MAX_MESSAGE_BYTES);
    }
    return this.#maxMessageBytes;
  }

  ping(): void {
    if (this.#state !== 1) return;
    // Control messages jump the queue: a ping stuck behind 20 MiB of transcript would
    // read as a dead peer, which is exactly what the heartbeat must not conclude.
    this.#channel.sendMessageBinary(controlMessage(PING));
  }

  close(code: number = CLOSE_NORMAL, reason = ""): void {
    if (this.#state >= 2) return;
    this.#state = 2;
    try {
      this.#channel.sendMessageBinary(closeMessage(code, reason));
    } catch {
      // The channel may already be gone; the close below settles it.
    }
    // The close message is already in the channel's buffer, ahead of this. Closing the
    // channel at once is what libdatachannel needs to flush it and tell the peer.
    this.#finish(code, reason);
  }

  terminate(): void {
    this.#finish(CLOSE_ABNORMAL, "");
  }

  #receive(message: string | Buffer | ArrayBuffer): void {
    if (this.#closed) return;
    // Strings are not part of the format: everything is binary, text included.
    if (typeof message === "string") return this.#violation("text message");
    const bytes = message instanceof ArrayBuffer ? Buffer.from(message) : message;
    let incoming;
    try {
      incoming = this.#assembler.push(bytes);
    } catch (error) {
      if (error instanceof FrameError) return this.#violation(error.message);
      throw error;
    }
    switch (incoming.kind) {
      case "frame":
        this.emit("message", incoming.data, incoming.binary);
        return;
      case "ping":
        try {
          this.#channel.sendMessageBinary(controlMessage(PONG));
        } catch {
          // closing
        }
        return;
      case "pong":
        this.emit("pong");
        return;
      case "close":
        this.#state = 2;
        this.#finish(incoming.code, incoming.reason);
        return;
      case "partial":
        return;
    }
  }

  /** The other end broke the format. Nothing it sends can be trusted from here on. */
  #violation(reason: string): void {
    this.close(CLOSE_PROTOCOL, reason);
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#queue.length > 0 && this.#channel.bufferedAmount() < HIGH_WATER_BYTES) {
      const next = this.#queue.shift()!;
      this.#queuedBytes -= next.message.byteLength;
      let failed = false;
      try {
        this.#channel.sendMessageBinary(next.message);
        failed = !this.#channel.isOpen();
      } catch {
        failed = true;
      }
      if (failed) {
        next.done?.(new Error("data channel send failed"));
        this.#finish(CLOSE_ABNORMAL, "send failed");
        return;
      }
      // Handed to the channel, which is the progress the backpressure guard counts; the
      // phone's acknowledgement does not exist at this layer.
      next.done?.();
    }
  }

  #finish(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = 3;
    const pending = this.#queue;
    this.#queue = [];
    this.#queuedBytes = 0;
    const error = new Error("data channel closed");
    for (const item of pending) item.done?.(error);
    try {
      this.#channel.close();
    } catch {
      // already closed
    }
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
}
