import * as ImageManipulator from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";

export const MAX_COMPOSER_IMAGES = 4;
export const MAX_IMAGE_LONG_SIDE = 2048;
/** Keep one prompt comfortably below the server's frame and memory limits. */
export const MAX_IMAGE_BASE64_LENGTH = 5_500_000;

export type ComposerImage = {
  id: string;
  data: string;
  mimeType: string;
  uri: string;
  width: number;
  height: number;
};

let nextId = 0;

function imageId(): string {
  nextId = (nextId + 1) % 1_000_000;
  return `image-${Date.now()}-${nextId}`;
}

export function fromDataUrl(dataUrl: string, width: number, height: number, fallbackMimeType = "image/jpeg"): ComposerImage | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match || !match[2]) return null;
  const mimeType = match[1] || fallbackMimeType;
  const data = match[2];
  if (data.length > MAX_IMAGE_BASE64_LENGTH) return null;
  return { id: imageId(), data, mimeType, uri: dataUrl, width, height };
}

/**
 * Re-encodes selected photos as a bounded JPEG. The image picker can return the
 * original PNG/HEIC dimensions, so quality alone is not enough to keep a phone
 * prompt small; resizing happens before base64 is put on the WebSocket.
 */
export async function preparePickedImage(asset: ImagePickerAsset): Promise<ComposerImage> {
  if (asset.type && asset.type !== "image") throw new Error("image-unsupported");
  const scale = Math.min(1, MAX_IMAGE_LONG_SIDE / Math.max(asset.width || 1, asset.height || 1));
  const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
  if (scale < 1) {
    context.resize({ width: Math.max(1, Math.round((asset.width || 1) * scale)), height: Math.max(1, Math.round((asset.height || 1) * scale)) });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.78, base64: true });
  if (!saved.base64) throw new Error("image-encoding-failed");
  if (saved.base64.length > MAX_IMAGE_BASE64_LENGTH) throw new Error("image-too-large");
  return {
    id: imageId(),
    data: saved.base64,
    mimeType: "image/jpeg",
    uri: `data:image/jpeg;base64,${saved.base64}`,
    width: saved.width,
    height: saved.height,
  };
}

export function promptImage(image: ComposerImage): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: image.data, mimeType: image.mimeType };
}
