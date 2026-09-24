import type { ChatAttachment } from "@shared/types";

/**
 * A photo from the phone, made fit to send.
 *
 * The desktop's `filesToAttachments` takes a file as it is, which on a phone goes wrong
 * twice. An iPhone camera shot is HEIC, which that helper does not count as an image —
 * it became a bare file chip with no path, so the model heard nothing about it. And a
 * phone photo is 3–12 MB, all of which crosses the tunnel as base64 inside one WebSocket
 * frame. So every image is decoded by the browser (Safari reads HEIC natively), scaled
 * so its longer side is at most `MAX_EDGE`, and re-encoded as JPEG: a model cannot use
 * more detail than that, and the upload shrinks by an order of magnitude.
 */

const MAX_EDGE = 2048;
const QUALITY = 0.85;

export async function photoToAttachment(file: File): Promise<ChatAttachment | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return {
      id: crypto.randomUUID(),
      kind: "image",
      name: `${base}.jpg`,
      mimeType: "image/jpeg",
      dataUrl,
    };
  } finally {
    bitmap.close();
  }
}
