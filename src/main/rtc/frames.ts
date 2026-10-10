import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * How one App Protocol frame travels over a WebRTC data channel.
 *
 * The protocol is whole JSON text frames (and, once negotiated, binary attachment frames)
 * of up to 24 MiB. A data channel is a message pipe with a small ceiling — 64 KiB in
 * libdatachannel by default, 256 KiB in the browsers' stack, and what interoperates
 * everywhere is about 16 KiB — so a frame is cut into fragments and put back together on
 * the other side. The phone implements the same format (`lib/protocol/rtc_frames.dart`);
 * change one and the other stops understanding it.
 *
 * Every data channel message is one fragment: a one-byte header, then payload.
 *
 *   header bit 0x01  LAST    final fragment of a frame (a frame of any length ends with one)
 *   header bit 0x02  BINARY  the frame is binary rather than UTF-8 text; set on every fragment
 *   header bit 0x04  PING    control, no payload; the peer answers PONG
 *   header bit 0x08  PONG    control, no payload
 *   header bit 0x10  CLOSE   control; payload is a big-endian u16 close code, then a UTF-8 reason
 *   header bit 0x20  DEFLATE the frame's bytes are raw-deflate compressed (RFC 1951); set on every fragment
 *
 * DEFLATE exists for the relay: through FastVibe's TURN server a phone on mobile data can be
 * a few hundred milliseconds from this computer, where a transcript of a megabyte of JSON is
 * the difference between seconds and a fraction of one. A sender may only set it once the
 * peer has said it understands it — the phone offers `deflate`, the desktop's answer agrees
 * — because an older reader refuses unknown header bits and closes the channel. That
 * agreement is permission, not a decision: the bit is per fragment, so a sender compresses
 * only while the selected path is the relay and sends the rest as it is.
 *
 * The channel must be reliable and ordered (the default), which is what lets fragments
 * carry no sequence number: a sender never interleaves two frames, so every fragment up to
 * the next LAST belongs to one frame. Control messages may fall between the fragments of a
 * frame and are handled where they arrive.
 */

export const LAST = 0x01;
export const BINARY = 0x02;
export const PING = 0x04;
export const PONG = 0x08;
export const CLOSE = 0x10;
export const DEFLATE = 0x20;

/** Frames shorter than this are sent as they are: the saving would not pay for the work. */
export const COMPRESS_MIN_BYTES = 1024;
/**
 * Frames at least this large are compressed off Main's thread (`ChannelSocket.send`).
 * Below it the work is under a millisecond and a round trip to the thread pool costs more.
 */
export const ASYNC_COMPRESS_MIN_BYTES = 64 * 1024;
/**
 * Level 3: most of the gain of level 9 at a fraction of the time, and JSON, which is
 * nearly everything here, compresses well early.
 */
export const COMPRESS_LEVEL = 3;

/**
 * Largest data channel message sent, header included, when the peer's limit is unknown.
 *
 * 16 KiB is what interoperates with every stack. A direct path may send more — up to
 * `DIRECT_MAX_MESSAGE_BYTES` — but only once the open channel reports that the peer
 * negotiated at least that much. Guessing high closes the channel.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/**
 * A direct path's ceiling. libdatachannel's own default, so a negotiated channel can take it.
 * Not raised further on purpose: 128 KiB was measured against 64 on loopback (12 MB, real
 * peers) and made no difference, so there is nothing to buy by sending closer to the limit.
 */
export const DIRECT_MAX_MESSAGE_BYTES = 64 * 1024;

/** Close reasons are short by contract (WebSocket allows 123 bytes). */
const MAX_REASON_BYTES = 123;

export class FrameError extends Error {}

/**
 * The frame, compressed — or null when that is not worth sending: too short, or no
 * smaller. Synchronous, so for frames small enough that it costs nothing to notice.
 */
export function compressFrame(data: Uint8Array): Buffer | null {
  if (data.byteLength < COMPRESS_MIN_BYTES) return null;
  const packed = deflateRawSync(data, { level: COMPRESS_LEVEL });
  return packed.byteLength < data.byteLength ? packed : null;
}

/**
 * Cut one frame into data channel messages. An empty frame is a single empty LAST fragment.
 * `deflated` says `data` is already compressed (`compressFrame`) and marks every fragment.
 */
export function splitFrame(data: Uint8Array, binary: boolean, deflated = false, maxMessageBytes = MAX_MESSAGE_BYTES): Buffer[] {
  const flag = (binary ? BINARY : 0) | (deflated ? DEFLATE : 0);
  if (data.byteLength === 0) return [Buffer.from([LAST | flag])];
  const payloadBytes = Math.max(1, maxMessageBytes - 1);
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += payloadBytes) {
    const end = Math.min(offset + payloadBytes, data.byteLength);
    const message = Buffer.allocUnsafe(1 + end - offset);
    message[0] = flag | (end === data.byteLength ? LAST : 0);
    message.set(data.subarray(offset, end), 1);
    out.push(message);
  }
  return out;
}

export function controlMessage(kind: typeof PING | typeof PONG): Buffer {
  return Buffer.from([kind]);
}

export function closeMessage(code: number, reason = ""): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, MAX_REASON_BYTES);
  const message = Buffer.allocUnsafe(3 + text.byteLength);
  message[0] = CLOSE;
  message.writeUInt16BE(code & 0xffff, 1);
  message.set(text, 3);
  return message;
}

export type Incoming =
  | { kind: "frame"; data: Buffer; binary: boolean }
  | { kind: "ping" }
  | { kind: "pong" }
  | { kind: "close"; code: number; reason: string }
  | { kind: "partial" };

/** Puts fragments back together. One per channel. */
export class FrameAssembler {
  #maxBytes: number;
  #parts: Buffer[] = [];
  #bytes = 0;
  #binary = false;
  #deflated = false;

  constructor(maxFrameBytes: number) {
    this.#maxBytes = maxFrameBytes;
  }

  /** Throws `FrameError` for anything the format does not allow; the channel is then not trusted. */
  push(message: Uint8Array): Incoming {
    if (message.byteLength === 0) throw new FrameError("empty message");
    const header = message[0];
    if (header & PING) return { kind: "ping" };
    if (header & PONG) return { kind: "pong" };
    if (header & CLOSE) {
      if (message.byteLength < 3) throw new FrameError("close message too short");
      const view = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
      return { kind: "close", code: view.readUInt16BE(1), reason: view.toString("utf8", 3) };
    }
    if (header & ~(LAST | BINARY | DEFLATE)) throw new FrameError("unknown header bits");

    const binary = (header & BINARY) !== 0;
    const deflated = (header & DEFLATE) !== 0;
    if (this.#parts.length > 0 && (binary !== this.#binary || deflated !== this.#deflated)) {
      throw new FrameError("fragment kind changed mid-frame");
    }
    this.#binary = binary;
    this.#deflated = deflated;
    const payload = message.subarray(1);
    this.#bytes += payload.byteLength;
    if (this.#bytes > this.#maxBytes) throw new FrameError("frame too large");
    this.#parts.push(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
    if (!(header & LAST)) return { kind: "partial" };

    const packed = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts, this.#bytes);
    this.#parts = [];
    this.#bytes = 0;
    if (!deflated) return { kind: "frame", data: packed, binary };
    try {
      // Bounded by the same ceiling as an uncompressed frame, so a few kilobytes cannot
      // be inflated into memory the limit was meant to protect.
      return { kind: "frame", data: inflateRawSync(packed, { maxOutputLength: this.#maxBytes }), binary };
    } catch {
      throw new FrameError("bad compressed frame");
    }
  }
}
