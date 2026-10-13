import type { ToolCallStatus, ToolImage } from "./types";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

/**
 * A stopped delegated run is still an error result for the parent model: that is how
 * it learns the delegation did not finish. In the transcript, though, it is an
 * intentional cancellation rather than a failure and must not be drawn as a red
 * tool error.
 *
 * Use the structured result details instead of matching text such as "aborted" — a
 * real provider or tool failure is allowed to contain that word.
 */
export function toolResultStatus(
  toolName: string | undefined,
  isError: boolean,
  details: unknown,
): ToolCallStatus {
  if (!isError) return "done";
  if (toolName?.toLowerCase() !== "subagent") return "error";

  const results = asRecord(details)?.results;
  if (
    Array.isArray(results) &&
    results.some((result) => asRecord(result)?.stopReason === "aborted")
  ) {
    return "aborted";
  }
  return "error";
}

/** An image block bigger than this is not carried through the transcript (base64 characters). */
export const MAX_RESULT_IMAGE_CHARS = 12 * 1024 * 1024;
/** Images of one tool result carried through the transcript. */
export const MAX_RESULT_IMAGES = 4;

/**
 * The image blocks of a tool result's content. An image generator behind MCP answers with the
 * picture itself, not a path, so this is the only place that picture exists; it is carried as a
 * data URL, bounded so one result cannot swamp a snapshot.
 */
export function toolImagesOf(content: unknown): ToolImage[] {
  if (!Array.isArray(content)) return [];
  const images: ToolImage[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const block = part as Record<string, unknown>;
    if (block.type !== "image" || typeof block.data !== "string") continue;
    if (block.data.length === 0 || block.data.length > MAX_RESULT_IMAGE_CHARS) continue;
    const mimeType = typeof block.mimeType === "string" && block.mimeType.startsWith("image/") ? block.mimeType : "image/png";
    images.push({ mimeType, dataUrl: `data:${mimeType};base64,${block.data}` });
    if (images.length >= MAX_RESULT_IMAGES) break;
  }
  return images;
}
