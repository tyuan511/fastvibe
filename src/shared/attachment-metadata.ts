import type { ChatAttachment } from "./types.ts";

/** The tags that mark a prompt's model-facing tail: `attachmentPromptSuffix` writes them, this module reads them back. */
export const ATTACHMENT_TAG = "fastvibe-attachments";
export const PASTED_TEXT_TAG = "fastvibe-pasted-text";

/**
 * What the engine appends to a user message after it resizes an attached picture, so the
 * model can map coordinates back to the original file. The reader already sees the photo,
 * so no surface should show the sentence — but it sits at the very end of the text the
 * prompt was built from, so anything that reads that text has to look past it.
 *
 * `pi`'s `formatDimensionNote` (utils/image-resize) is the writer; one note per resized
 * image, each separated by a blank line. Anchored to the end, so a prompt that merely
 * quotes it mid-text is left alone.
 */
const IMAGE_DIMENSION_NOTE =
  /(?:\n{2}\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\])+\s*$/;

/**
 * The model-facing blocks we append to a prompt: a list of dropped-in file paths, and the
 * content of a paste too long for the input box. Either may come last, and the engine's
 * image note may sit past both.
 */
export const MODEL_FACING_TAIL =
  /(?:\n{2,}<fastvibe-attachments>\n[\s\S]*?<\/fastvibe-attachments>|\n{2,}<fastvibe-pasted-text>\n[\s\S]*?<\/fastvibe-pasted-text>)+\s*$/;

/** The note alone, so a reader can show the words a person actually typed. */
export function imagePromptText(text: string): string {
  if (!text.includes("[Image: original ")) return text;
  const stripped = text.replace(IMAGE_DIMENSION_NOTE, "");
  return stripped === text ? text : stripped.trimEnd();
}

/**
 * The whole message the engine holds for a prompt: the person's words plus the model-facing
 * blocks we append to them, with the engine's own image notes on the end of that.
 *
 * Order matters here. We append the attachment block last, then the engine appends its note
 * after it — so a prompt carrying both a picture and a file ends with the note, and matching
 * the blocks while the note is still there finds nothing. The file is then invisible to every
 * reader, including the one that rebuilds the chips to re-send an edited prompt.
 */
export function stripPromptMetadata(text: string): string {
  const withoutNote = imagePromptText(text);
  if (!withoutNote.includes(`<${ATTACHMENT_TAG}>`) && !withoutNote.includes(`<${PASTED_TEXT_TAG}>`)) {
    return withoutNote;
  }
  const stripped = withoutNote.replace(MODEL_FACING_TAIL, "");
  return stripped === withoutNote ? withoutNote : stripped.trimEnd();
}

const FILE_BLOCK = /\n{2,}<fastvibe-attachments>\n([\s\S]*?)\n<\/fastvibe-attachments>(?=\n{2,}<fastvibe-pasted-text>|\s*$)/;
const PASTED_TEXT_BLOCK = /\n{2,}<fastvibe-pasted-text>\n([\s\S]*)\n<\/fastvibe-pasted-text>\s*$/;

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

/** Rebuild attachment chips from the model-facing metadata persisted in user messages. */
export function extractPromptAttachments(text: string): ChatAttachment[] {
  const body = imagePromptText(text);
  const attachments: ChatAttachment[] = [];
  const fileBody = body.match(FILE_BLOCK)?.[1];
  if (fileBody) {
    for (const line of fileBody.split("\n")) {
      const path = line.startsWith("- ") ? line.slice(2).trim() : "";
      if (!path) continue;
      attachments.push({ id: `file:${path}`, kind: "file", name: fileName(path), path });
    }
  }

  const pastedBody = body.match(PASTED_TEXT_BLOCK)?.[1];
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
        // The content is the attachment. A chip without it can be drawn but never
        // re-sent: editing or retrying that prompt would silently drop the paste the
        // model was answering, so the reader would get a different turn than the first.
        text: item.content,
      });
    });
  } catch {
    // Malformed model-facing metadata stays ordinary message text and yields no chip.
  }
  return attachments;
}
