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
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_IMAGE_REF_FIELD, toolImageRef, type ToolImageRef } from "../../shared/tool-image-ref.ts";

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

function isInlineImage(block: unknown): block is Block & { data: string } {
  return isRecord(block) && block.type === "image" && typeof block.data === "string" && block.data.length > 0;
}

function imageMimeType(block: Block): string {
  return typeof block.mimeType === "string" && block.mimeType.startsWith("image/") ? block.mimeType : "image/png";
}

/**
 * The biggest picture turned into a reference, as base64. A larger one stays inline: only then
 * does the SDK's own normalization (run after the `tool_result` hook) still see it, which is
 * what keeps a picture the resizer could not shrink within what a provider accepts.
 */
export const MAX_REFERENCED_IMAGE_CHARS = 6 * 1024 * 1024;

/** Where the copy of one picture the model is sent lives, beside the full-size one. */
export function modelToolImagePath(dir: string, conversationId: string, toolCallId: string, index: number, mimeType: string): string {
  const extension = EXTENSIONS[mimeType.toLowerCase()] ?? "png";
  return join(dir, toolImageFolder(conversationId), "model", `${safeName(toolCallId, "call")}-${index}.${extension}`);
}

function referenceBlock(ref: ToolImageRef, path: string): Block {
  return { type: "text", text: `[${ref.mimeType} tool result, saved at ${path}]`, [TOOL_IMAGE_REF_FIELD]: ref };
}

/**
 * A tool result's content with each inline picture written to disk as the copy the model is
 * sent and replaced by a reference to it (`shared/tool-image-ref.ts`). `undefined` when nothing
 * changed. A picture that cannot be written, or is too big to leave the SDK's normalization,
 * stays inline. Run on the result as it arrives, after `shrinkToolResultImages`, and on the
 * entries of a transcript written before this existed as it is opened.
 */
export function referenceToolResultImages(content: unknown, dir: string, conversationId: string, toolCallId: string): Block[] | undefined {
  if (!Array.isArray(content) || !content.some(isInlineImage)) return undefined;
  const folder = toolImageFolder(conversationId);
  let index = 0;
  let changed = false;
  const next = (content as unknown[]).map((block) => {
    if (toolImageRef(block)) {
      index += 1;
      return block as Block;
    }
    if (!isInlineImage(block)) return block as Block;
    const at = index++;
    if (block.data.length > MAX_REFERENCED_IMAGE_CHARS) return block;
    const mimeType = imageMimeType(block);
    const path = modelToolImagePath(dir, conversationId, toolCallId, at, mimeType);
    if (!save(path, block.data)) return block;
    changed = true;
    const file = `model/${safeName(toolCallId, "call")}-${at}.${EXTENSIONS[mimeType.toLowerCase()] ?? "png"}`;
    return referenceBlock({ folder, file, mimeType, chars: block.data.length, index: at }, path);
  });
  return changed ? next : undefined;
}

/**
 * Swap the inline pictures of a loaded transcript's tool results for references, in place.
 *
 * A chat from before references existed still carries every screenshot as base64 — one real
 * transcript held 78 MB of them — and the SDK keeps all of it in memory for as long as the
 * session lives. Rewriting the entries the session was just built from frees that, and the
 * request hook reads the newest ones back exactly as it does for a new chat. The file on disk
 * is not touched: the SDK only ever appends to it. Returns how many results changed.
 */
export function referenceStoredToolImages(entries: readonly unknown[], dir: string, conversationId: string): number {
  let changed = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "toolResult") continue;
    const content = referenceToolResultImages(message.content, dir, conversationId, String(message.toolCallId ?? ""));
    if (!content) continue;
    message.content = content;
    changed += 1;
  }
  return changed;
}

/**
 * The file a reference names: this conversation's own copy first — a fork links the pictures it
 * inherits into its own folder — then the folder that wrote it.
 */
export function resolveToolImageRef(dir: string, conversationId: string, ref: ToolImageRef): string | undefined {
  const own = join(dir, toolImageFolder(conversationId), ref.file);
  if (existsSync(own)) return own;
  const written = join(dir, ref.folder, ref.file);
  return existsSync(written) ? written : undefined;
}

/** The full-size original behind a reference, for the chat to draw; the model's copy when there is none. */
function referencedImagePath(dir: string, conversationId: string, toolCallId: string, ref: ToolImageRef): string | undefined {
  return findSaved(dir, conversationId, toolCallId, ref.index)
    ?? findSaved(dir, ref.folder, toolCallId, ref.index)
    ?? resolveToolImageRef(dir, conversationId, ref);
}

/** Where a picture can be read again, for the note that replaces one left out of a request. */
export function locateToolImage(dir: string, conversationId: string, toolCallId: string, index: number, block: Block): string | undefined {
  const ref = toolImageRef(block);
  return ref ? referencedImagePath(dir, conversationId, toolCallId, ref) : savedToolImagePath(dir, conversationId, toolCallId, index, block);
}

/**
 * Pictures read back for requests, kept for the next one.
 *
 * Every request of a chat carries the same newest pictures, so they are read from disk once and
 * served from here after that, bounded by size. A file is never rewritten once saved (`save`
 * keeps an existing one), so a path is a safe key.
 */
export class ToolImageReader {
  #cache = new Map<string, string>();
  #chars = 0;
  readonly maxChars: number;

  constructor(maxChars = 16 * 1024 * 1024) {
    this.maxChars = maxChars;
  }

  async read(path: string | undefined): Promise<string | undefined> {
    if (!path) return undefined;
    const cached = this.#cache.get(path);
    if (cached !== undefined) {
      this.#cache.delete(path);
      this.#cache.set(path, cached);
      return cached;
    }
    let data: string;
    try {
      data = (await readFile(path)).toString("base64");
    } catch {
      return undefined;
    }
    if (data.length === 0) return undefined;
    if (data.length <= this.maxChars) {
      this.#cache.set(path, data);
      this.#chars += data.length;
      while (this.#chars > this.maxChars) {
        const oldest = this.#cache.keys().next().value!;
        this.#chars -= this.#cache.get(oldest)!.length;
        this.#cache.delete(oldest);
      }
    }
    return data;
  }
}

/**
 * Give a fork the pictures of the tool results it copied, as hard links into its own folder (a
 * copy where links are not possible). A reference resolves to the fork's own folder first, so
 * deleting the chat it was forked from — which deletes that chat's folder — takes nothing from it.
 */
export function linkToolImages(dir: string, fromConversationId: string, toConversationId: string, toolCallIds: Iterable<string>): number {
  const from = join(dir, toolImageFolder(fromConversationId));
  const to = join(dir, toolImageFolder(toConversationId));
  if (from === to || !existsSync(from)) return 0;
  const calls = new Set([...toolCallIds].map((id) => safeName(id, "call")));
  let linked = 0;
  for (const sub of ["", "model"]) {
    let names: string[];
    try {
      names = readdirSync(join(from, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".tmp")) continue;
      const dash = name.lastIndexOf("-");
      if (dash <= 0 || !calls.has(name.slice(0, dash))) continue;
      const target = join(to, sub, name);
      if (existsSync(target)) continue;
      try {
        mkdirSync(join(to, sub), { recursive: true });
        try {
          linkSync(join(from, sub, name), target);
        } catch {
          copyFileSync(join(from, sub, name), target);
        }
        linked += 1;
      } catch {
        // A picture that cannot be carried over is reported missing where it is drawn.
      }
    }
  }
  return linked;
}

/**
 * `content` with each inline image block replaced by a path block, and each reference by a path
 * block for its full-size original (dropped when no file is left behind it — its sentence is not
 * output). Returns the same array when there was nothing to do, so a caller can tell "unchanged"
 * from a new list.
 */
export function externalizeToolImages(content: unknown, dir: string, conversationId: string, toolCallId: string): unknown {
  if (!Array.isArray(content) || !content.some((block) => isInlineImage(block) || toolImageRef(block))) {
    return content;
  }
  let index = 0;
  const out: unknown[] = [];
  for (const block of content as unknown[]) {
    const ref = toolImageRef(block);
    if (ref) {
      index += 1;
      const path = referencedImagePath(dir, conversationId, toolCallId, ref);
      if (path) out.push({ type: "image", mimeType: mimeTypeOfPath(path) ?? ref.mimeType, path });
      continue;
    }
    if (!isInlineImage(block)) {
      out.push(block);
      continue;
    }
    const mimeType = imageMimeType(block);
    const at = index++;
    const path = findSaved(dir, conversationId, toolCallId, at) ?? toolImagePath(dir, conversationId, toolCallId, at, mimeType);
    out.push(save(path, block.data) ? { type: "image", mimeType: mimeTypeOfPath(path) ?? mimeType, path } : block);
  }
  return out;
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
