/**
 * Tool-result images, as the model is sent them.
 *
 * An image generator behind MCP answers with the picture itself, and the SDK puts every earlier
 * tool result back into each request: after twenty generations the body carries twenty base64
 * pictures on every turn. Past a gateway's body limit the request is refused outright (413, or a
 * 502 / timeout) whichever model sits behind it. The SDK only normalizes each picture on its own
 * (2000px, 4.5MB), which a 3 MB picture passes, so nothing bounds the sum.
 *
 * Pictures are therefore shrunk once as they arrive (`fastvibe-tool-images`, via
 * `shrinkToolResultImages`), which is what keeps a request small. What is left here is the
 * backstop: before each request the pictures are cut, oldest first, until they fit
 * `MAX_KEPT_IMAGE_CHARS`, and the newest is always kept. It matters for a chat from before the
 * shrinking existed, whose pictures are still full size, and for a very long one.
 *
 * A dropped picture is replaced by a note naming the file it is saved in, so the model can `read`
 * it again. Only the request changes: the chat draws the full-size file saved for the picture, and
 * a reload loses nothing. Only tool-result images are handled; an image the user attached is theirs.
 */

import { toolImageRef, type ToolImageRef } from "../../shared/tool-image-ref.ts";

/** Base64 characters of tool-result images one request may carry. The newest image is always kept. */
export const MAX_KEPT_IMAGE_CHARS = 4 * 1024 * 1024;

type Block = Record<string, unknown>;
type Message = Record<string, unknown>;

/** Where a dropped picture can be read again: the tool result, the picture's place among that result's images, the block. */
export type LocateImage = (message: Message, index: number, block: Block) => string | undefined;

export type DropOptions = { maxChars?: number; locate?: LocateImage };

function isRecord(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImage(block: unknown): block is Block {
  return isRecord(block) && block.type === "image";
}

function imageBlocks(message: unknown): Block[] {
  if (!isRecord(message) || message.role !== "toolResult" || !Array.isArray(message.content)) return [];
  return message.content.filter(isImage);
}

function note(block: Block, path: string | undefined): Block {
  const ref = toolImageRef(block);
  const mime = ref ? ref.mimeType : typeof block.mimeType === "string" ? block.mimeType : "image";
  const where = path ? `It is saved at ${path}; read that file if you need to see it again.` : "Regenerate it if you need to see it again.";
  return { type: "text", text: `[An earlier ${mime} result was left out of the context to keep requests small. ${where}]` };
}

/**
 * `messages` with the oldest tool-result images replaced by a short note until the rest fit the
 * budget. Returns the same array when nothing needs dropping, so the caller can tell "no change"
 * from a new list. Messages that are not touched are returned as they are, not copied.
 */
export function dropOldToolImages<T>(messages: readonly T[], options: DropOptions = {}): readonly T[] {
  const { maxChars = MAX_KEPT_IMAGE_CHARS, locate } = options;
  const sizes = messages.flatMap((message) => imageBlocks(message).map((block) => (typeof block.data === "string" ? block.data.length : 0)));
  let kept = sizes.reduce((sum, size) => sum + size, 0);
  let toDrop = 0;
  while (kept > maxChars && toDrop < sizes.length - 1) kept -= sizes[toDrop++];
  if (toDrop === 0) return messages;

  return messages.map((message) => {
    if (toDrop === 0 || imageBlocks(message).length === 0) return message;
    const source = message as Message;
    let position = 0;
    const content = (source.content as unknown[]).map((block) => {
      if (!isImage(block)) return block;
      const index = position++;
      if (toDrop === 0) return block;
      toDrop--;
      return note(block, locate?.(source, index, block));
    });
    return { ...source, content } as T;
  });
}

/** Read a referenced picture back as base64; `undefined` when its file is gone. */
export type LoadImage = (ref: ToolImageRef, message: Message) => Promise<string | undefined>;

export type PrepareOptions = DropOptions & { load: LoadImage };

/** A tool-result picture as a request sees it: inline bytes, or a reference to a file. */
function isPicture(block: unknown): block is Block {
  return isImage(block) || toolImageRef(block) !== undefined;
}

function pictureSize(block: Block): number {
  const ref = toolImageRef(block);
  if (ref) return ref.chars;
  return typeof block.data === "string" ? block.data.length : 0;
}

/** How many of the oldest pictures leave so that the rest fit; the newest always stays. */
function oldestToDrop(sizes: readonly number[], maxChars: number): number {
  let kept = sizes.reduce((sum, size) => sum + size, 0);
  let toDrop = 0;
  while (kept > maxChars && toDrop < sizes.length - 1) kept -= sizes[toDrop++];
  return toDrop;
}

/**
 * `dropOldToolImages` for a history that also holds references (`shared/tool-image-ref.ts`):
 * one budget over both, newest first, and every reference that stays is read back into the
 * image it stands for. A reference left out becomes the same note an inline picture would; one
 * whose file is gone becomes a note that it is no longer available. Returns the same array when
 * there is nothing to change — no reference, and nothing over budget.
 */
export async function prepareRequestToolImages<T>(messages: readonly T[], options: PrepareOptions): Promise<readonly T[]> {
  const { maxChars = MAX_KEPT_IMAGE_CHARS, locate, load } = options;
  const pictures = (message: unknown): Block[] =>
    isRecord(message) && message.role === "toolResult" && Array.isArray(message.content) ? message.content.filter(isPicture) : [];
  const sizes = messages.flatMap((message) => pictures(message).map(pictureSize));
  let toDrop = oldestToDrop(sizes, maxChars);
  const hasRef = messages.some((message) => pictures(message).some((block) => toolImageRef(block) !== undefined));
  if (toDrop === 0 && !hasRef) return messages;

  const next: T[] = [];
  for (const message of messages) {
    if (pictures(message).length === 0) {
      next.push(message);
      continue;
    }
    const source = message as Message;
    let position = 0;
    const content: unknown[] = [];
    for (const block of source.content as unknown[]) {
      if (!isPicture(block)) {
        content.push(block);
        continue;
      }
      const index = position++;
      if (toDrop > 0) {
        toDrop--;
        content.push(note(block, locate?.(source, index, block)));
        continue;
      }
      const ref = toolImageRef(block);
      if (!ref) {
        content.push(block);
        continue;
      }
      const data = await load(ref, source);
      content.push(data
        ? { type: "image", data, mimeType: ref.mimeType }
        : { type: "text", text: `[An earlier ${ref.mimeType} result is no longer available. Regenerate it if you need to see it again.]` });
    }
    next.push({ ...source, content } as T);
  }
  return next;
}
