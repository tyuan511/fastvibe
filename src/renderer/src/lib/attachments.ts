import type { ChatAttachment, PromptImage } from "@shared/types";

type NativeFile = File & { path?: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function filesToAttachments(files: File[]): Promise<ChatAttachment[]> {
  const result: ChatAttachment[] = [];
  for (const file of files) {
    const native = file as NativeFile;
    const mime = file.type || guessMime(file.name);
    if (IMAGE_TYPES.has(mime) && file.size <= MAX_IMAGE_BYTES) {
      const dataUrl = await readDataUrl(file);
      result.push({
        id: crypto.randomUUID(),
        kind: "image",
        name: file.name,
        mimeType: mime,
        dataUrl,
        path: native.path,
      });
      continue;
    }
    result.push({
      id: crypto.randomUUID(),
      kind: "file",
      name: file.name,
      mimeType: mime || undefined,
      path: native.path,
    });
  }
  return result;
}

export function attachmentsToImages(items: ChatAttachment[]): PromptImage[] {
  return items.flatMap((item) => {
    if (item.kind !== "image" || !item.dataUrl) return [];
    const comma = item.dataUrl.indexOf(",");
    const data = comma >= 0 ? item.dataUrl.slice(comma + 1) : item.dataUrl;
    return [{ type: "image", data, mimeType: item.mimeType || "image/png" }];
  });
}

export function attachmentPromptSuffix(items: ChatAttachment[]): string {
  const files = items.filter((item) => item.kind === "file" && item.path);
  if (files.length === 0) return "";
  return `\n\n附件：\n${files.map((item) => `- ${item.path}`).join("\n")}`;
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "";
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
