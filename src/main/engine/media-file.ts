import { createReadStream, realpathSync, statSync, type ReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { authorizeMediaMime, parseByteRange } from "../../shared/media-preview.ts";

export type MediaOpen =
  | { ok: false; status: number; headers?: Record<string, string> }
  | { ok: true; status: 200 | 206; headers: Record<string, string>; stream: ReadStream | null };

/**
 * Open a local image, video or PDF for a streamed response.
 *
 * The caller writes the status and pipes `stream`. A video seek is a `Range` on this
 * same file, so the slice is the only bytes that leave disk.
 */
export function openMediaBody(filePath: string, method: string, rangeHeader: string | null): MediaOpen {
  if (method !== "GET" && method !== "HEAD") return { ok: false, status: 405 };
  if (!isAbsolute(filePath) || filePath.includes("\0")) return { ok: false, status: 400 };
  let real: string;
  try {
    real = realpathSync(filePath);
  } catch {
    return { ok: false, status: 404 };
  }
  const mime = authorizeMediaMime(filePath, real);
  if (!mime) return { ok: false, status: 403 };
  let size: number;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) return { ok: false, status: 404 };
    size = stat.size;
  } catch {
    return { ok: false, status: 404 };
  }
  const range = parseByteRange(rangeHeader, size);
  if (range === "invalid") {
    return { ok: false, status: 416, headers: { "content-range": `bytes */${size}` } };
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? (size > 0 ? size - 1 : 0);
  const headers: Record<string, string> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(size === 0 ? 0 : end - start + 1),
    "x-content-type-options": "nosniff",
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  if (method === "HEAD" || size === 0) {
    return { ok: true, status: range ? 206 : 200, headers, stream: null };
  }
  return {
    ok: true,
    status: range ? 206 : 200,
    headers,
    stream: createReadStream(real, { start, end }),
  };
}
