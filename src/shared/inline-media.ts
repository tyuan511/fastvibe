import { isHtmlFile, mediaPreviewKind, mediaPreviewUrl } from "./media-preview.ts";
import { officeFormatOf } from "./office.ts";
import type { ToolCallBlock } from "./types.ts";

/**
 * What a reply shows in the conversation itself — an image, a video, an HTML page — instead of
 * a path the reader has to open in the side pane.
 *
 * Three things put one on screen:
 *
 * 1. **`present`** — the model says "show this". Local files, https URLs and data URLs.
 * 2. **An image in a producing tool's result** — an image generator returns the picture as an
 *    image block, with no file at all. Readers and tools of unknown purpose do not qualify.
 * 3. **A `write`** of an image or HTML file — the tool's own argument names the file.
 *
 * Printed paths are not evidence of production: even "saved to" may be text read from an old
 * log. A script or a tool that returns only paths uses `present` to show its deliverables.
 *
 * Nothing here reads the disk: a preview is a reference, and the renderer loads it the way the
 * file preview does (`fastvibe-media://`). That keeps the list recomputable from the transcript.
 */

export type InlineMediaKind = "image" | "video" | "html" | "office";

export type InlinePreview = {
  /** Unique within one reply. */
  key: string;
  kind: InlineMediaKind;
  /** A path (or remote ref) the host can read, an https URL, or a `data:` URL. */
  ref: string;
  title?: string;
  /**
   * `true` when the model or a tool named it (`present`, `write`, an image block): a failure to
   * load is shown. `false` for a guess from a result's text, which is dropped quietly.
   */
  explicit: boolean;
};

/** Per tool call, and per reply. A script that prints fifty paths is not fifty previews. */
const MAX_PER_TOOL = 4;
const MAX_PER_REPLY = 12;

const WEB_VIDEO = new Set([".mp4", ".m4v", ".webm", ".ogv", ".mov"]);
const WEB_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]);

function extOf(pathname: string): string {
  const name = pathname.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function kindOfExt(ext: string): InlineMediaKind | null {
  if (WEB_IMAGE.has(ext)) return "image";
  if (WEB_VIDEO.has(ext)) return "video";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".docx" || ext === ".xlsx" || ext === ".pptx") return "office";
  return null;
}

/**
 * What an inline preview can be made of a reference.
 *
 * An https URL is an image or a video, never a page: an HTML page there is a website, and a
 * frame onto it is not something the model should be able to open in the transcript.
 */
export function classifyRef(ref: string): InlineMediaKind | null {
  const value = ref.trim();
  if (!value) return null;
  if (value.startsWith("data:")) {
    const mime = /^data:([a-z]+\/[a-z0-9.+-]+)[;,]/i.exec(value)?.[1]?.toLowerCase();
    if (!mime) return null;
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    return null;
  }
  if (/^https:\/\//i.test(value)) {
    let pathname: string;
    try {
      pathname = new URL(value).pathname;
    } catch {
      return null;
    }
    const kind = kindOfExt(extOf(pathname));
    // A page, and an Office file, are rendered from a local path. An https URL of either is a
    // download, not something this transcript can frame.
    return kind === "html" || kind === "office" ? null : kind;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  // A path, absolute or relative: the extension decides.
  if (isHtmlFile(value)) return "html";
  if (officeFormatOf(value)) return "office";
  const media = mediaPreviewKind(value);
  if (media === "image" || media === "video") return kindOfExt(extOf(value));
  return null;
}

/** The URL an `<img>`, `<video>` or `<iframe>` loads for a reference. */
export function inlineSrc(preview: Pick<InlinePreview, "ref">): string {
  const { ref } = preview;
  if (ref.startsWith("data:") || /^https:\/\//i.test(ref)) return ref;
  return mediaPreviewUrl(ref);
}

/** An absolute or scoped path is something a host can read; a bare relative one needs a base. */
function isPathRef(ref: string): boolean {
  return !ref.startsWith("data:") && !/^https:\/\//i.test(ref);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file"];

function argPath(tool: ToolCallBlock): string {
  const args = record(tool.args);
  if (!args) return "";
  for (const key of PATH_KEYS) {
    const value = text(args[key]);
    if (value) return value;
  }
  return "";
}

function isWriteTool(name: string): boolean {
  return /^(write|write_file|writefile|create_file|createfile|create)$/i.test(name.trim());
}

// Match words, including MCP prefixes and camelCase names in older transcripts. A server's
// original tool name, when recorded, avoids mistaking its namespace for the operation.
const INPUT_OPERATION = /(?:^|_)(?:read|view|open|inspect|analyze|analyse|describe|list|search|find|get|fetch|load|browser|computer|screenshot|snapshot|capture|todo|question|preview|probe)(?:_|$)/;
const OUTPUT_OPERATION = /(?:^|_)(?:generate|gen|imagegen|create|write|edit|render|export|convert|resize|upscale|transform)(?:_|$)/;

function operationWords(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function producesImages(name: string, args?: unknown, details?: unknown): boolean {
  const mcp = record(record(details)?.mcp);
  if (mcp?.readOnlyHint === true) return false;
  const operation = operationWords(text(mcp?.toolName) || name);
  if (INPUT_OPERATION.test(operation) || !OUTPUT_OPERATION.test(operation)) return false;
  // Some MCP tools multiplex reads and writes behind one name.
  const params = record(args);
  return ![params?.action, params?.operation, params?.method].some((value) => INPUT_OPERATION.test(operationWords(text(value))));
}

function hasOutputImages(tool: ToolCallBlock): boolean {
  if (tool.name !== "codemode") return producesImages(tool.name, tool.args, tool.details);
  // A script's image blocks have no per-image provenance. Only accept an unambiguous batch
  // of successful producing calls; mixed reads/generation must select outputs with `present`.
  const calls = record(tool.details)?.calls;
  return Array.isArray(calls) && calls.length > 0 && calls.every((item) => {
    const call = record(item);
    if (!call || call.status !== "ok") return false;
    let args: unknown = call.args;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { return false; }
    }
    return producesImages(text(call.name), args);
  });
}

function presentItems(tool: ToolCallBlock): Array<{ ref: string; title?: string }> {
  const details = record(tool.details);
  const fromDetails = Array.isArray(details?.items) ? details.items : null;
  const out: Array<{ ref: string; title?: string }> = [];
  if (fromDetails) {
    for (const item of fromDetails) {
      const row = record(item);
      if (!row || row.ok === false) continue;
      const ref = text(row.ref);
      if (ref) out.push({ ref, title: text(row.title) || undefined });
    }
    return out;
  }
  const args = record(tool.args);
  if (Array.isArray(args?.items)) {
    for (const item of args.items) {
      const row = record(item);
      const ref = typeof item === "string" ? item.trim() : text(row?.source) || text(row?.path) || text(row?.url);
      if (ref) out.push({ ref, title: text(row?.title) || undefined });
    }
  }
  return out;
}

/**
 * The previews one reply's tool calls ask for, by tool id, each reference at most once
 * (the first call to name it keeps it).
 *
 * `resolve` turns a path the tool wrote or printed into the reference the host reads —
 * project-relative onto the conversation's directory, a remote project's onto its scoped id.
 */
export function collectInlinePreviews(
  tools: ToolCallBlock[],
  resolve: (path: string) => string = (path) => path,
): Map<string, InlinePreview[]> {
  const byTool = new Map<string, InlinePreview[]>();
  const claimed = new Set<string>();
  let total = 0;

  for (const tool of tools) {
    if (tool.status !== "done" || tool.parentId) continue;
    const out: InlinePreview[] = [];
    const add = (rawRef: string, explicit: boolean, title?: string): void => {
      if (out.length >= MAX_PER_TOOL || total + out.length >= MAX_PER_REPLY) return;
      const ref = isPathRef(rawRef) ? resolve(rawRef) : rawRef;
      const kind = classifyRef(ref);
      if (!kind || claimed.has(ref)) return;
      claimed.add(ref);
      out.push({ key: `${tool.id}:${out.length}`, kind, ref, title, explicit });
    };

    if (tool.name === "present") {
      for (const item of presentItems(tool)) add(item.ref, true, item.title);
    } else {
      if (isWriteTool(tool.name)) {
        const path = argPath(tool);
        if (path && classifyRef(path)) add(path, true);
      }
      if (hasOutputImages(tool)) {
        for (const image of tool.images ?? []) {
          const ref = image.path ?? image.dataUrl;
          if (ref) add(ref, true);
        }
      }
    }
    if (out.length > 0) {
      byTool.set(tool.id, out);
      total += out.length;
    }
  }
  return byTool;
}
