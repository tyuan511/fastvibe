/**
 * Byte progress for the local embedding download.
 *
 * Transformers.js `pipeline()` (4.3.0) builds `progress_total` from the default
 * fp32 name `onnx/model.onnx` and does not forward `model_file_name`. That file
 * is never fetched — dtype `fp32` plus the explicit base name asks for
 * `onnx/<modelFileName>.onnx` — but the prefetch leaves it in the map at 0
 * bytes. Added to the real INT8 file and the tokenizer, that is the 570 MB the
 * bar used to show. Count only files this download actually fetches, and wait
 * until the ONNX file itself has been reported so the bar does not fill on the
 * tokenizer and then jump backwards.
 */
export type DownloadFileProgress = { loaded?: number; total?: number };

const PHANTOM_ONNX = "onnx/model.onnx";

export function embeddingDownloadBytes(
  files: Record<string, DownloadFileProgress | undefined> | undefined,
  modelFileName: string,
): { loaded: number; total: number } | undefined {
  if (!files || typeof files !== "object") return undefined;
  const modelPath = `onnx/${modelFileName}.onnx`;
  if (!Object.prototype.hasOwnProperty.call(files, modelPath)) return undefined;
  let loaded = 0;
  let total = 0;
  for (const [name, info] of Object.entries(files)) {
    if (name === PHANTOM_ONNX && name !== modelPath) continue;
    if (!info || typeof info.total !== "number" || !(info.total > 0)) continue;
    const fileLoaded = typeof info.loaded === "number" && info.loaded > 0 ? info.loaded : 0;
    loaded += Math.min(fileLoaded, info.total);
    total += info.total;
  }
  if (!(total > 0)) return undefined;
  return { loaded, total };
}
