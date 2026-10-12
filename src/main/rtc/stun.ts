import { randomBytes } from "node:crypto";

/**
 * The one STUN exchange this desktop makes itself: a Binding request, and the public
 * address in the answer (RFC 8489).
 *
 * The WebRTC library does the same thing inside a call, on a socket nothing else can
 * use. This is for asking *before* a call, on sockets of our own, how the network in
 * front of this computer behaves — which is what decides how the call's socket is set up.
 */

const MAGIC = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;

export type MappedAddress = { address: string; port: number };

/** A Binding request and the transaction id its answer has to carry. */
export function bindingRequest(): { id: Buffer; packet: Buffer } {
  const id = randomBytes(12);
  const header = Buffer.alloc(8);
  header.writeUInt16BE(BINDING_REQUEST, 0);
  header.writeUInt16BE(0, 2);
  MAGIC.copy(header, 4);
  return { id, packet: Buffer.concat([header, id]) };
}

/**
 * The address a Binding success reports, or null for anything else — another
 * transaction's answer, an error, or bytes that are not STUN at all.
 */
export function mappedAddress(packet: Buffer, id: Buffer): MappedAddress | null {
  if (packet.length < 20 || packet.readUInt16BE(0) !== BINDING_SUCCESS) return null;
  if (!packet.subarray(4, 8).equals(MAGIC) || !packet.subarray(8, 20).equals(id)) return null;
  const end = Math.min(packet.length, 20 + packet.readUInt16BE(2));
  let plain: MappedAddress | null = null;
  for (let at = 20; at + 4 <= end; ) {
    const type = packet.readUInt16BE(at);
    const length = packet.readUInt16BE(at + 2);
    const value = packet.subarray(at + 4, at + 4 + length);
    if (value.length < length) break;
    // The XOR form is the one to trust: a NAT that rewrites addresses it finds in a
    // payload cannot find this one.
    if (type === XOR_MAPPED_ADDRESS) return readAddress(value, id, true) ?? plain;
    if (type === MAPPED_ADDRESS) plain = readAddress(value, id, false);
    at += 4 + length + ((4 - (length % 4)) % 4);
  }
  return plain;
}

function readAddress(value: Buffer, id: Buffer, xored: boolean): MappedAddress | null {
  if (value.length < 8) return null;
  const family = value[1];
  const port = value.readUInt16BE(2) ^ (xored ? MAGIC.readUInt16BE(0) : 0);
  if (family === 0x01) {
    const bytes = Buffer.from(value.subarray(4, 8));
    if (xored) for (let i = 0; i < 4; i += 1) bytes[i] ^= MAGIC[i];
    return { address: [...bytes].join("."), port };
  }
  if (family === 0x02 && value.length >= 20) {
    const bytes = Buffer.from(value.subarray(4, 20));
    const mask = Buffer.concat([MAGIC, id]);
    if (xored) for (let i = 0; i < 16; i += 1) bytes[i] ^= mask[i];
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    return { address: groups.join(":"), port };
  }
  return null;
}
