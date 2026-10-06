/**
 * Generate a UUID without assuming the page is a secure context.
 *
 * `crypto.randomUUID()` is unavailable to HTTP-served remote clients in some
 * browsers. `getRandomValues()` is a wider-supported Web Crypto primitive, so
 * use it to keep renderer-only ids UUID-shaped before falling back to the
 * non-cryptographic path available in every JavaScript runtime.
 */
export type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

export function randomUUID(source: RandomSource = globalThis.crypto): string {
  if (typeof source.randomUUID === "function") return source.randomUUID();

  if (typeof source.getRandomValues === "function") {
    const bytes = source.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(bytes);
  }

  const bytes = randomBytes();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  const now = Date.now();
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256) ^ ((now / 2 ** (index % 8)) | 0);
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
