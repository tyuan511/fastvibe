import type { ChatAttachment } from "./types.ts";

const FILE_BLOCK = /\n{2,}<fastvibe-attachments>\n([\s\S]*?)\n<\/fastvibe-attachments>(?=\n{2,}<fastvibe-pasted-text>|\s*$)/;
const PASTED_TEXT_BLOCK = /\n{2,}<fastvibe-pasted-text>\n([\s\S]*)\n<\/fastvibe-pasted-text>\s*$/;

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

/** Rebuild attachment chips from the model-facing metadata persisted in user messages. */
export function extractPromptAttachments(text: string): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  const fileBody = text.match(FILE_BLOCK)?.[1];
  if (fileBody) {
    for (const line of fileBody.split("\n")) {
      const path = line.startsWith("- ") ? line.slice(2).trim() : "";
      if (!path) continue;
      attachments.push({ id: `file:${path}`, kind: "file", name: fileName(path), path });
    }
  }

  const pastedBody = text.match(PASTED_TEXT_BLOCK)?.[1];
  if (!pastedBody) return attachments;
  try {
    const parsed: unknown = JSON.parse(pastedBody);
    if (!Array.isArray(parsed)) return attachments;
    parsed.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const name = "name" in item && typeof item.name === "string" && item.name.trim()
        ? item.name
        : "pasted-text.txt";
      if (!("content" in item) || typeof item.content !== "string") return;
      attachments.push({
        id: `pasted:${index}:${name}`,
        kind: "file",
        name,
        mimeType: "text/plain",
      });
    });
  } catch {
    // Malformed model-facing metadata stays ordinary message text and yields no chip.
  }
  return attachments;
}
