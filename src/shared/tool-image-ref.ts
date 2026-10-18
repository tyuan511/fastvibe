/**
 * A tool result's picture kept on disk, standing in the transcript where its base64 was.
 *
 * The SDK writes a tool result into the transcript as it returns, and keeps it in memory
 * for the life of the session. A chat that took a few hundred screenshots therefore held
 * tens of megabytes of base64 in its file and in Main's heap — parsed on every open, cloned
 * into every request, and almost all of it never sent again: a request carries at most the
 * newest few megabytes of pictures (`context-images.ts`). So the picture the model is sent
 * is written beside the full-size one (`tool-images/<conversation>/model/`), and the block
 * becomes a reference: `type: "text"`, so every reader that does not know it — the SDK's
 * compaction, a summary, the pi CLI — sees a plain sentence naming the file, with the
 * reference itself under `fastvibeImage`. Before each request the newest references are read
 * back into images; the chat draws the full-size original by the same index.
 *
 * Pure and shared: the projection that strips the sentence from tool output runs in Main,
 * and the summary sent to a phone counts a reference as a picture, as it did the bytes.
 */

export const TOOL_IMAGE_REF_FIELD = "fastvibeImage";

export type ToolImageRef = {
  /** The conversation folder under `tool-images/` the files were written in. */
  folder: string;
  /** The copy the model is sent, relative to that folder: `model/<call>-<index>.<ext>`. */
  file: string;
  mimeType: string;
  /** That copy's size as base64, so a request's budget is planned without reading it. */
  chars: number;
  /** Its place among the result's pictures; the full-size original is `<call>-<index>.*`. */
  index: number;
};

const FILE = /^model\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/;
const FOLDER = /^[A-Za-z0-9._-]+$/;

/**
 * The reference a content block carries, or `undefined`. Validated here so no caller can be
 * pointed outside the pictures folder by a hand-edited or imported transcript.
 */
export function toolImageRef(block: unknown): ToolImageRef | undefined {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
  const value = (block as Record<string, unknown>)[TOOL_IMAGE_REF_FIELD];
  if (typeof value !== "object" || value === null) return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.folder !== "string" || !FOLDER.test(ref.folder) || ref.folder.startsWith(".")) return undefined;
  if (typeof ref.file !== "string" || !FILE.test(ref.file) || ref.file.includes("..")) return undefined;
  if (typeof ref.mimeType !== "string" || !ref.mimeType.startsWith("image/")) return undefined;
  const chars = typeof ref.chars === "number" && Number.isFinite(ref.chars) && ref.chars >= 0 ? ref.chars : 0;
  const index = typeof ref.index === "number" && Number.isInteger(ref.index) && ref.index >= 0 ? ref.index : 0;
  return { folder: ref.folder, file: ref.file, mimeType: ref.mimeType, chars, index };
}

/** Whether a block is such a reference: readers of tool output skip its sentence. */
export function isToolImageRef(block: unknown): boolean {
  return toolImageRef(block) !== undefined;
}
