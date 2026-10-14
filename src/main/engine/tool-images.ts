/**
 * Pictures a tool returned, saved to disk so nothing downstream has to carry their bytes.
 *
 * An image generator behind MCP answers with the picture inline. Drawing it from a data URL put
 * megabytes of base64 into every transcript read, every IPC reply and the renderer's store, and
 * made each of them slower as a chat made more images. The file is written once, under a name
 * derived from the call (`<conversationId>/<toolCallId>-<n>.<ext>`), so rewriting the same
 * result again is a cheap existence check; the client gets `{ type: "image", mimeType, path }`
 * and reads the file through `fastvibe-media://`, like any other path.
 *
 * The engine's own transcript is not touched: the SDK still holds the bytes for the model.
 * A picture that cannot be written stays as it is and falls back to a data URL.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Block = Record<string, unknown>;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

function mimeTypeOfPath(path: string): string | undefined {
  const extension = path.split(".").pop();
  return Object.entries(EXTENSIONS).find(([, value]) => value === extension)?.[0];
}

function isRecord(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeName(value: string, fallback: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return safe || fallback;
}

/** The folder a conversation's pictures live in. */
export function toolImageFolder(conversationId: string): string {
  return safeName(conversationId, "chat");
}

/** Where one picture of one call lives. */
export function toolImagePath(dir: string, conversationId: string, toolCallId: string, index: number, mimeType: string): string {
  const extension = EXTENSIONS[mimeType.toLowerCase()] ?? "png";
  return join(dir, toolImageFolder(conversationId), `${safeName(toolCallId, "call")}-${index}.${extension}`);
}

/** The saved picture of this call and position, whatever its extension: a shrunk copy may be another format than the original. */
function findSaved(dir: string, conversationId: string, toolCallId: string, index: number): string | undefined {
  for (const extension of new Set(Object.values(EXTENSIONS))) {
    const path = join(dir, toolImageFolder(conversationId), `${safeName(toolCallId, "call")}-${index}.${extension}`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function save(path: string, data: string): boolean {
  try {
    if (existsSync(path)) return true;
    mkdirSync(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, Buffer.from(data, "base64"));
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The saved copy of one picture of a result, written if it is not there yet. `index` counts the
 * result's image blocks, as `externalizeToolImages` does, so both name the same file.
 */
export function savedToolImagePath(dir: string, conversationId: string, toolCallId: string, index: number, block: Block): string | undefined {
  if (typeof block.data !== "string" || block.data.length === 0) return undefined;
  const mimeType = typeof block.mimeType === "string" && block.mimeType.startsWith("image/") ? block.mimeType : "image/png";
  const existing = findSaved(dir, conversationId, toolCallId, index);
  if (existing) return existing;
  const path = toolImagePath(dir, conversationId, toolCallId, index, mimeType);
  return save(path, block.data) ? path : undefined;
}

/** A picture re-encoded smaller, as base64 — `null` when it cannot be (no decoder, an unreadable file). */
export type ImageResizer = (bytes: Buffer, mimeType: string) => Promise<{ data: string; mimeType: string } | null>;

/**
 * A tool result's content as it should enter the history: every picture saved in full (for the
 * chat to show) and replaced by a smaller copy (for the model). Returns `undefined` when nothing
 * changed. A picture the resizer cannot shrink, or shrinks to something no smaller, stays as it was.
 *
 * Done once, as the result arrives, so every later request, reload and fork carries the small
 * copy; the original lives only in `dir`, which `externalizeToolImages` then finds by name.
 */
export async function shrinkToolResultImages(
  content: unknown,
  dir: string,
  conversationId: string,
  toolCallId: string,
  resize: ImageResizer,
): Promise<Block[] | undefined> {
  if (!Array.isArray(content) || !content.some((block) => isRecord(block) && block.type === "image" && typeof block.data === "string")) {
    return undefined;
  }
  let index = 0;
  let changed = false;
  const next: Block[] = [];
  for (const block of content as unknown[]) {
    if (!isRecord(block) || block.type !== "image" || typeof block.data !== "string" || block.data.length === 0) {
      next.push(block as Block);
      continue;
    }
    const at = index++;
    savedToolImagePath(dir, conversationId, toolCallId, at, block);
    const mimeType = typeof block.mimeType === "string" && block.mimeType.startsWith("image/") ? block.mimeType : "image/png";
    let resized: Awaited<ReturnType<ImageResizer>> = null;
    try {
      resized = await resize(Buffer.from(block.data, "base64"), mimeType);
    } catch {
      resized = null;
    }
    if (resized && resized.data.length < block.data.length) {
      next.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
      changed = true;
    } else {
      next.push(block);
    }
  }
  return changed ? next : undefined;
}

/**
 * `content` with each inline image block replaced by a path block. Returns the same array when
 * there was nothing to save, so a caller can tell "unchanged" from a new list.
 */
export function externalizeToolImages(content: unknown, dir: string, conversationId: string, toolCallId: string): unknown {
  if (!Array.isArray(content) || !content.some((block) => isRecord(block) && block.type === "image" && typeof block.data === "string")) {
    return content;
  }
  let index = 0;
  return content.map((block) => {
    if (!isRecord(block) || block.type !== "image" || typeof block.data !== "string" || block.data.length === 0) return block;
    const mimeType = typeof block.mimeType === "string" && block.mimeType.startsWith("image/") ? block.mimeType : "image/png";
    const at = index++;
    const path = findSaved(dir, conversationId, toolCallId, at) ?? toolImagePath(dir, conversationId, toolCallId, at, mimeType);
    if (!save(path, block.data)) return block;
    return { type: "image", mimeType: mimeTypeOfPath(path) ?? mimeType, path };
  });
}

/** A transcript with the pictures of its tool results externalized; messages without any are returned as they are. */
export function externalizeToolResultMessages<T>(messages: readonly T[], dir: string, conversationId: string): T[] {
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== "toolResult") return message;
    const content = externalizeToolImages(message.content, dir, conversationId, String(message.toolCallId ?? ""));
    return content === message.content ? message : ({ ...message, content } as T);
  });
}

/**
 * A live `tool_execution_end` event with its result's pictures externalized. Returns the event
 * itself when it carries none.
 */
export function externalizeToolEndEvent(event: Record<string, unknown>, dir: string | undefined, conversationId: string): Record<string, unknown> {
  if (!dir || event.type !== "tool_execution_end" || !isRecord(event.result)) return event;
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  const content = externalizeToolImages(event.result.content, dir, conversationId, toolCallId);
  return content === event.result.content ? event : { ...event, result: { ...event.result, content } };
}
