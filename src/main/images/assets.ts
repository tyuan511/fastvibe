import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GeneratedImage, ImageReference, ImageReferenceInput } from "../../shared/image-generation.ts";
import { uiText } from "../engine/ui-text.ts";

export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
export const MAX_REFERENCES = 1;
export type ImageBytes = { bytes: Buffer; mimeType: string; width?: number; height?: number };
export type PreparedReference = ImageReference & ImageBytes;

export function assertActive(signal: AbortSignal): void { signal.throwIfAborted(); }

/** Validate image signatures too: an upstream HTML error must never become an image file. */
export function inspectImage(bytes: Buffer, claimedMime?: string): ImageBytes {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(uiText("图片内容为空或超过大小限制。", "The image is empty or exceeds the size limit."));
  let mimeType: string;
  let width: number | undefined;
  let height: number | undefined;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = "image/png";
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") {
    mimeType = "image/webp";
    if (bytes.length >= 30 && bytes.subarray(12, 16).toString() === "VP8X") {
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = "image/jpeg";
  } else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) {
    mimeType = "image/gif";
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else throw new Error(uiText("服务未返回受支持的图片内容。", "The service did not return a supported image."));
  const normalized = claimedMime?.split(";")[0]?.trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (normalized && normalized !== mimeType && normalized !== "application/octet-stream") throw new Error(uiText("图片格式与内容不一致。", "The image format does not match its contents."));
  return { bytes, mimeType, ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

export function decodeImage(data: unknown, mimeType?: string): ImageBytes {
  if (typeof data !== "string" || !data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(uiText("服务返回的图片编码无效或过大。", "The image encoding is invalid or too large."));
  return inspectImage(Buffer.from(data, "base64"), mimeType);
}

export async function prepareReferences(inputs: ImageReferenceInput[], dir: string, signal: AbortSignal): Promise<PreparedReference[]> {
  if (inputs.length > MAX_REFERENCES) throw new Error(uiText("一次最多使用 1 张参考图。", "Use at most one reference image."));
  await mkdir(dir, { recursive: true });
  const references: PreparedReference[] = [];
  let total = 0;
  for (const [index, input] of inputs.entries()) {
    assertActive(signal);
    let image: ImageBytes;
    if ("path" in input) {
      if (typeof input.path !== "string" || !input.path) throw new Error(uiText("参考图路径无效。", "Invalid reference image path."));
      const info = await stat(input.path);
      if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) throw new Error(uiText("参考图必须是小于 12 MiB 的图片文件。", "Reference images must be image files smaller than 12 MiB."));
      image = inspectImage(await readFile(input.path));
    } else image = decodeImage(input.data, input.mimeType);
    total += image.bytes.length;
    if (image.bytes.length > MAX_REFERENCE_BYTES || total > 36 * 1024 * 1024) throw new Error(uiText("参考图超过大小限制。", "The reference images exceed the size limit."));
    assertActive(signal);
    const path = join(dir, `reference-${index + 1}.${extension(image.mimeType)}`);
    await writeFile(path, image.bytes, { mode: 0o600, signal });
    assertActive(signal);
    references.push({ ...image, path, name: typeof input.name === "string" ? input.name.slice(0, 200) : `reference-${index + 1}` });
  }
  return references;
}

export async function saveImage(image: ImageBytes, dir: string, index: number, signal: AbortSignal): Promise<GeneratedImage> {
  assertActive(signal);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `image-${index + 1}.${extension(image.mimeType)}`);
  await writeFile(path, image.bytes, { mode: 0o600, signal });
  assertActive(signal);
  return { id: randomUUID(), index, path, mimeType: image.mimeType, width: image.width, height: image.height };
}

export async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  assertActive(signal);
  const length = Number(response.headers.get("content-length"));
  if (length > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(uiText("服务返回的内容超过大小限制。", "The service response exceeds the size limit."));
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      assertActive(signal);
      const { done, value } = await reader.read();
      assertActive(signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(uiText("服务返回的内容超过大小限制。", "The service response exceeds the size limit."));
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function extension(mimeType: string): string {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[mimeType] ?? "png";
}
