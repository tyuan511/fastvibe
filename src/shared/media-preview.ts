import { decodeScopedId } from "./server-scope.ts";

// Not `node:path`: the renderer imports this module too, and a bundled browser build has
// no `path` to call — `extname` would be `undefined` the first time a reply shows a file.
function extname(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function isAbsolute(filePath: string): boolean {
  return filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
}

/**
 * File preview hands the renderer a URL, not the bytes.
 *
 * The desktop window loads that URL with a native `<img>` or `<video>`, and the main
 * process streams the file (including the byte ranges a video seeks with). A remote
 * file uses the same URL: main proxies it as a binary stream, so the preview JSON
 * never carries a base64 copy.
 */
export const MEDIA_SCHEME = "fastvibe-media";

const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
};

export type MediaPreviewKind = "image" | "video" | "pdf";

export function mediaMime(filePath: string): string | undefined {
  return MEDIA_MIME[extname(filePath).toLowerCase()];
}

export function mediaPreviewKind(filePath: string): MediaPreviewKind | null {
  const mime = mediaMime(filePath);
  if (!mime) return null;
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  return "image";
}

const HTML_MIME = "text/html; charset=utf-8";

/**
 * An HTML file is served by the same scheme so an inline preview can run in a
 * sandboxed frame of its own document (a `srcdoc` frame would inherit the app's CSP and
 * could never run a script). It is not a "media kind": `readFilePreview` still reads it as text.
 */
export function isHtmlFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

/**
 * What a served HTML page may do. The frame that shows it is sandboxed without
 * `allow-same-origin`, so it has no storage, no cookies and no access to the app; this adds
 * that it can load only inline code and https resources (a chart library from a CDN), cannot
 * reach a local file, a form target or another frame, and has no `<base>` to redirect with.
 */
export const INLINE_HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "media-src data: blob: https:",
  "font-src data: https:",
  "connect-src https:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The content type a path is served with, or `null` when it is neither media nor an HTML page. */
function servedMime(filePath: string): string | null {
  return mediaMime(filePath) ?? (isHtmlFile(filePath) ? HTML_MIME : null);
}

/** Both the requested path and its real path must be servable, so a renamed symlink cannot point at something else. */
export function authorizeMediaMime(requested: string, real: string): string | null {
  const mime = servedMime(real);
  if (!mime || !servedMime(requested)) return null;
  // A page is never reached under a media name, nor a picture under a page's.
  if (isHtmlFile(requested) !== isHtmlFile(real)) return null;
  return mime;
}

export function mediaPreviewUrl(filePath: string): string {
  const url = new URL(`${MEDIA_SCHEME}://media/play`);
  url.searchParams.set("path", filePath);
  return url.toString();
}

export function mediaPathFromUrl(requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== "media") return null;
  const filePath = url.searchParams.get("path");
  if (!filePath || filePath.includes("\0")) return null;
  if (decodeScopedId(filePath) || isAbsolute(filePath)) return filePath;
  return null;
}

export type ByteRange = { start: number; end: number };

/** One `Range: bytes=` interval. `null` means the header was absent; `"invalid"` is a 416. */
export function parseByteRange(header: string | null, size: number): ByteRange | "invalid" | null {
  if (!header) return null;
  if (size <= 0) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return "invalid";
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isInteger(start) || start < 0 || start >= size) return "invalid";
  const end = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(end) || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}
