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

/** Largest data channel message sent, header included. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = MAX_MESSAGE_BYTES - 1;

/** Close reasons are short by contract (WebSocket allows 123 bytes). */
const MAX_REASON_BYTES = 123;

export class FrameError extends Error {}

/** Cut one frame into data channel messages. An empty frame is a single empty LAST fragment. */
export function splitFrame(data: Uint8Array, binary: boolean): Buffer[] {
  const flag = binary ? BINARY : 0;
  if (data.byteLength === 0) return [Buffer.from([LAST | flag])];
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += MAX_PAYLOAD_BYTES) {
    const end = Math.min(offset + MAX_PAYLOAD_BYTES, data.byteLength);
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
    if (header & ~(LAST | BINARY)) throw new FrameError("unknown header bits");

    const binary = (header & BINARY) !== 0;
    if (this.#parts.length > 0 && binary !== this.#binary) throw new FrameError("fragment kind changed mid-frame");
    this.#binary = binary;
    const payload = message.subarray(1);
    this.#bytes += payload.byteLength;
    if (this.#bytes > this.#maxBytes) throw new FrameError("frame too large");
    this.#parts.push(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
    if (!(header & LAST)) return { kind: "partial" };

    const data = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts, this.#bytes);
    this.#parts = [];
    this.#bytes = 0;
    return { kind: "frame", data, binary };
  }
}
