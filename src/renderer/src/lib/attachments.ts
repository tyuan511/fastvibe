import type { ChatAttachment, PromptImage } from "@shared/types";

type NativeFile = File & { path?: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Long clipboard text becomes a file chip instead of overwhelming the composer. */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 500;

export function shouldAttachPastedText(text: string): boolean {
  return text.length > PASTED_TEXT_ATTACHMENT_THRESHOLD;
}

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

/**
 * The file paths a model needs in order to read an attached file, appended to the
 * prompt.
 *
 * A path list is model-facing metadata, not something the user typed, so the
 * transcript strips it again on the way to the screen (`stripAttachmentBlock`) — the
 * chips above the bubble are how the reader sees the attachment. The block is tagged
 * rather than labelled so it reads identically in every UI language; only what the
 * model *answers* follows 界面语言.
 */
export function attachmentPromptSuffix(items: ChatAttachment[]): string {
  const files = items.filter((item) => item.kind === "file" && item.path);
  const pasted = items.flatMap((item) =>
    item.kind === "file" && typeof item.text === "string"
      ? [{ name: item.name, content: item.text }]
      : [],
  );
  const blocks: string[] = [];
  if (files.length > 0) {
    blocks.push(`<${ATTACHMENT_TAG}>\n${files.map((item) => `- ${item.path}`).join("\n")}\n</${ATTACHMENT_TAG}>`);
  }
  if (pasted.length > 0) {
    blocks.push(`<${PASTED_TEXT_TAG}>\n${JSON.stringify(pasted)}\n</${PASTED_TEXT_TAG}>`);
  }
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

const ATTACHMENT_TAG = "fastvibe-attachments";
const PASTED_TEXT_TAG = "fastvibe-pasted-text";
/**
 * Generated attachment blocks, anchored to the end so a prompt that merely quotes
 * either tag mid-text is left alone.
 */
const ATTACHMENT_BLOCK = new RegExp(
  `(?:\\n{2,}<${ATTACHMENT_TAG}>\\n[\\s\\S]*?</${ATTACHMENT_TAG}>|` +
  `\\n{2,}<${PASTED_TEXT_TAG}>\\n[\\s\\S]*?</${PASTED_TEXT_TAG}>)+\\s*$`,
);

/**
 * Strip the model-facing attachment block for display.
 *
 * The engine's own copy of a user message keeps the block (a retry replays it, and a
 * file attachment cannot be recovered from the transcript any other way), so every
 * reader that shows a prompt has to go through here — otherwise the bubble grows the
 * path list the moment the transcript is re-read.
 */
export function stripAttachmentBlock(text: string): string {
  if (!text.includes(`<${ATTACHMENT_TAG}>`) && !text.includes(`<${PASTED_TEXT_TAG}>`)) return text;
  const stripped = text.replace(ATTACHMENT_BLOCK, "");
  return stripped === text ? text : stripped.trimEnd();
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
