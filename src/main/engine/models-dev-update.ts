import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildSnapshot, downloadCatalog } from "../../../scripts/models-dev-encode.mjs";
import { loadModelsDev, localIndexPath, modelsDevCatalogSignature, reloadModelsDev, type ModelsDevStats } from "./models-dev";
import { uiText } from "./ui-text";

export type ModelsDevUpdateResult = ModelsDevStats & {
  /** False when the download carries the same catalog already in use. */
  changed: boolean;
};

/**
 * Refresh the models.dev metadata from upstream.
 *
 * Called hourly (`models-dev-refresh.ts`) and on demand from Settings → 关于. The bundled
 * snapshot only changes when the app does, but model limits and prices move far faster
 * than releases, so the current catalog is written into the app's data directory, where
 * `loadModelsDev()` prefers it. The encoding is the same code the build uses
 * (`scripts/models-dev-encode.mjs`), so an updated snapshot is byte-for-byte the format
 * the decoder and the sync script already agree on.
 *
 * `changed` is false when the download matches the catalog already loaded. The file is
 * still replaced — its timestamp is what the hourly schedule waits on — but the caller
 * can skip rebinding live sessions that would see the same limits and prices.
 */
export async function updateModelsDevSnapshot(): Promise<ModelsDevUpdateResult> {
  let catalog: unknown;
  try {
    catalog = await downloadCatalog();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(uiText(`无法连接 models.dev：${detail}`, `Could not reach models.dev: ${detail}`));
  }

  const snapshot = buildSnapshot(catalog);
  // Never trade a working snapshot for an empty one: a truncated or unexpected catalog
  // would otherwise wipe every model's limits and prices.
  if (snapshot.m.length === 0) {
    throw new Error(uiText("models.dev 没有返回任何模型", "models.dev returned no models"));
  }

  const changed = modelsDevCatalogSignature() !== JSON.stringify([snapshot.v, snapshot.m, snapshot.x]);
  const path = localIndexPath();
  await mkdir(dirname(path), { recursive: true });
  // Same write-then-rename dance as the build script: a crash mid-write leaves the
  // previous snapshot intact rather than a half-written file for the decoder to read.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot));
  await rename(tmp, path);
  reloadModelsDev();
  return { ...loadModelsDev().stats, changed };
}
