/**
 * Small binary side-channel for image prompt data.
 *
 * The App Protocol remains JSON. A client that supports this feature sends one
 * binary WebSocket frame before the call and replaces the base64 `data` field with
 * an attachment id. Older clients keep sending the original JSON unchanged.
 */

const PREFIX = "fastvibe-attachment-v1:";
const ID_PATTERN = /^att_[A-Za-z0-9_-]{8,80}$/;

export type BinaryAttachment = {
  id: string;
  bytes: Uint8Array;
};

export type ExtractedAttachments = {
  message: unknown;
  attachments: BinaryAttachment[];
};

export function extractBinaryAttachments(value: unknown): ExtractedAttachments {
  const attachments: BinaryAttachment[] = [];
  const message = mapImages(value, (image) => {
    if (typeof image.data !== "string" || image.data.length === 0) return image;
    const bytes = decodeBase64(image.data);
    if (!bytes) return image;
    const id = newAttachmentId();
    attachments.push({ id, bytes });
    const { data: _data, ...reference } = image;
    return { ...reference, attachmentId: id };
  });
  return { message, attachments };
}

export function materializeBinaryAttachments(
  value: unknown,
  resolve: (id: string) => Uint8Array | undefined,
): { value: unknown; missing: string[] } {
  const missing: string[] = [];
  const next = mapImages(value, (image) => {
    if (typeof image.attachmentId !== "string") return image;
    const bytes = resolve(image.attachmentId);
    if (!bytes) {
      missing.push(image.attachmentId);
      return image;
    }
    const { attachmentId: _attachmentId, ...materialized } = image;
    return { ...materialized, data: encodeBase64(bytes) };
  });
  return { value: next, missing };
}

/** Encode one binary frame with a self-delimiting ASCII header. */
export function encodeBinaryAttachment(id: string, bytes: Uint8Array): Uint8Array {
  if (!ID_PATTERN.test(id)) throw new Error("invalid attachment id");
  const header = new TextEncoder().encode(`${PREFIX}${id}\n`);
  const frame = new Uint8Array(header.byteLength + bytes.byteLength);
  frame.set(header, 0);
  frame.set(bytes, header.byteLength);
  return frame;
}

/** Decode a binary frame, returning null for ordinary binary data. */
export function decodeBinaryAttachment(frame: Uint8Array): BinaryAttachment | null {
  const limit = Math.min(frame.byteLength, PREFIX.length + 81);
  let newline = -1;
  for (let i = 0; i < limit; i += 1) {
    if (frame[i] === 10) {
      newline = i;
      break;
    }
  }
  if (newline < 0) return null;
  const header = new TextDecoder().decode(frame.slice(0, newline));
  if (!header.startsWith(PREFIX)) return null;
  const id = header.slice(PREFIX.length);
  if (!ID_PATTERN.test(id)) return null;
  return { id, bytes: frame.slice(newline + 1) };
}

function mapImages(value: unknown, map: (image: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => mapImages(item, map));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "images" && Array.isArray(item)) {
      next[key] = item.map((image) => isRecord(image) && image.type === "image" ? map(image) : mapImages(image, map));
    } else {
      next[key] = mapImages(item, map);
    }
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newAttachmentId(): string {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, "");
  const suffix = uuid ?? Math.random().toString(36).slice(2).padEnd(32, "0");
  return `att_${suffix.slice(0, 32)}`;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

