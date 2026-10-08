import { stat } from "node:fs/promises";
import { join } from "node:path";

export const MEMORY_MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
// This upstream model names its INT8 artifacts explicitly. The pipeline's fp32
// dtype preserves this base filename instead of adding a quantization suffix.
export const MEMORY_MODEL_FILE = process.arch === "arm64" ? "model_qint8_arm64" : "model_qint8_avx2";

/**
 * Transformers.js 4.3's pipeline discovery does not forward cache_dir or
 * local_files_only to its metadata probes. A complete cache must therefore be
 * passed as a directory, rather than as a Hugging Face repo id.
 */
export async function memoryModelSource(cacheDir: string, allowDownload = false): Promise<{ model: string; localOnly: boolean }> {
  const directory = join(cacheDir, MEMORY_MODEL_ID);
  const files = ["config.json", "tokenizer.json", "tokenizer_config.json", `onnx/${MEMORY_MODEL_FILE}.onnx`];
  const complete = (await Promise.all(files.map(async (file) => {
    try {
      const info = await stat(join(directory, file));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }))).every(Boolean);
  if (complete) return { model: directory, localOnly: true };
  if (allowDownload) return { model: MEMORY_MODEL_ID, localOnly: false };
  throw new Error("The local memory model is not installed; prepare it in Memory settings");
}
