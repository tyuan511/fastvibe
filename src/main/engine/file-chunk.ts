import { open, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { uiText } from "./ui-text.ts";

/**
 * One slice of a file, for a client that cannot open an HTTP connection to the machine.
 *
 * The official phone connection is a single data channel carrying call frames; there is no
 * `/api/media` to stream from. A file therefore travels as base64 slices the client asks for
 * one after another, which also gives it progress and a place to stop.
 */
export const MAX_CHUNK_BYTES = 512 * 1024;
export const DEFAULT_CHUNK_BYTES = 384 * 1024;
/** Past this a file is refused rather than pulled over a phone connection. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export type FileChunk = {
  name: string;
  /** Whole file, in bytes, as of this read. */
  size: number;
  /** Changes when the file is rewritten, so a download can tell it is no longer one file. */
  mtimeMs: number;
  offset: number;
  /** Base64 of `[offset, offset + bytes)`. */
  data: string;
  /** This slice reaches the end of the file. */
  eof: boolean;
};

/** A path the tool wrote is relative to its conversation's directory, not to this process. */
export function resolveReadPath(rawPath: unknown, cwd: string | undefined): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.includes("\0")) {
    throw new Error(uiText("路径无效", "Invalid path"));
  }
  const path = rawPath.trim();
  if (isAbsolute(path)) return path;
  if (!cwd) throw new Error(uiText("无法确定文件所在目录", "Cannot tell which directory the file is in"));
  return resolve(cwd, path);
}

function integer(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(uiText(`${name} 无效`, `Invalid ${name}`));
  }
  return value;
}

export async function readFileChunk(filePath: string, rawOffset: unknown, rawLength: unknown): Promise<FileChunk> {
  const offset = integer(rawOffset, 0, "offset");
  const length = Math.min(integer(rawLength, DEFAULT_CHUNK_BYTES, "length"), MAX_CHUNK_BYTES);
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(uiText("文件不存在", "File does not exist"));
    }
    throw error;
  }
  if (!info.isFile()) throw new Error(uiText("不是文件", "Not a file"));
  if (info.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(uiText("文件过大，无法在手机上下载", "File is too large to download here"));
  }
  const name = basename(filePath);
  if (offset >= info.size || length === 0) {
    return { name, size: info.size, mtimeMs: info.mtimeMs, offset, data: "", eof: true };
  }
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(length, info.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return {
      name,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset,
      data: buffer.subarray(0, bytesRead).toString("base64"),
      eof: offset + bytesRead >= info.size,
    };
  } finally {
    await handle.close();
  }
}

/** The directory a conversation works in, from the catalog snapshot. */
export function conversationCwd(
  snapshot: { conversations: ReadonlyArray<{ id: string; cwd: string }> },
  conversationId: unknown,
): string | undefined {
  if (typeof conversationId !== "string" || !conversationId) return undefined;
  return snapshot.conversations.find((item) => item.id === conversationId)?.cwd;
}

/**
 * The method body shared by the desktop and the SSH Agent: resolve against the chat, then read.
 * The catalog is only consulted for a relative path — it is the same read for every slice.
 */
export async function readFileForPayload(
  payload: { path?: unknown; offset?: unknown; length?: unknown } | undefined,
  cwdOf: () => string | undefined,
): Promise<FileChunk> {
  const raw = payload?.path;
  const relative = typeof raw === "string" && raw.trim() !== "" && !isAbsolute(raw.trim());
  return readFileChunk(resolveReadPath(raw, relative ? cwdOf() : undefined), payload?.offset, payload?.length);
}
