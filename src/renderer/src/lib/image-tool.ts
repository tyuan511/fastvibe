import type { GeneratedImage, ImageTask, ImageTaskStatus } from "../../../shared/image-generation.ts";
import type { ToolCallBlock } from "../../../shared/types.ts";

export type ImageGenerationPreview = Pick<ImageTask, "id" | "prompt" | "options" | "images" | "status">;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonempty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(4, Math.trunc(value))) : undefined;

function terminal(value: unknown): Exclude<ImageTaskStatus, "generating"> | undefined {
  switch (value) {
    case "succeeded": case "partial": case "failed": case "cancelled": case "interrupted": return value;
    default: return undefined;
  }
}

function imagesOf(value: unknown, id: string, legacyItems = false): GeneratedImage[] {
  if (!Array.isArray(value)) return [];
  const images: GeneratedImage[] = [];
  for (let position = 0; position < value.length && images.length < 4; position++) {
    const row = record(value[position]);
    if (!row || (legacyItems && row.ok === false)) continue;
    const path = nonempty(legacyItems ? row.ref : row.path);
    if (!path) continue;
    const index = typeof row.index === "number" && Number.isInteger(row.index) && row.index >= 0 && row.index < 4 ? row.index : undefined;
    images.push({
      id: nonempty(row.id) ?? `${id}:${index ?? position}`,
      ...(index !== undefined ? { index } : {}),
      path,
      mimeType: nonempty(row.mimeType) ?? "image/png",
      ...(positive(row.width) !== undefined ? { width: positive(row.width) } : {}),
      ...(positive(row.height) !== undefined ? { height: positive(row.height) } : {}),
    });
  }
  return images;
}

/** Project a tool snapshot without stores, file reads, image bytes or transcript mutations. */
export function imagePreviewFromTool(tool: ToolCallBlock): ImageGenerationPreview {
  const args = record(tool.args);
  const details = record(tool.details);
  const task = record(details?.task);
  const options = record(task?.options);
  let result: Record<string, unknown> | undefined;
  if (typeof tool.result === "string") {
    try { result = record(JSON.parse(tool.result)); } catch { /* Plain text and unfinished JSON have no preview payload. */ }
  }
  const id = nonempty(task?.id) ?? nonempty(details?.taskId) ?? nonempty(result?.taskId) ?? tool.id;
  // An explicit empty task image list is authoritative; older payloads are only a fallback.
  let images: GeneratedImage[];
  if (Array.isArray(task?.images)) images = imagesOf(task.images, id);
  else {
    images = imagesOf(details?.items, id, true);
    if (!images.length) images = imagesOf(result?.images, id);
  }
  const taskTerminal = terminal(task?.status) ?? terminal(result?.status);
  const status: ImageTaskStatus = tool.status === "aborted" ? "cancelled"
    : tool.status === "running" ? taskTerminal ?? "generating"
    : taskTerminal === "cancelled" || taskTerminal === "interrupted" ? taskTerminal
    : tool.status === "error" ? (images.length ? "partial" : "failed")
    : taskTerminal ?? (images.length ? "succeeded" : "failed");
  const aspectRatio = nonempty(options?.aspectRatio) ?? nonempty(args?.aspect_ratio);
  const size = nonempty(options?.size) ?? nonempty(args?.size);
  const quality = nonempty(options?.quality) ?? nonempty(args?.quality);
  return {
    id,
    prompt: typeof task?.prompt === "string" ? task.prompt : typeof args?.prompt === "string" ? args.prompt : "",
    options: {
      count: countOf(options?.count) ?? countOf(args?.count) ?? 1,
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
    },
    images,
    status,
  };
}
