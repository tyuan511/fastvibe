#!/usr/bin/env node
/**
 * Bundle a compact, pre-indexed snapshot of models.dev into resources/models-dev/.
 *
 *   npm run sync:models
 *   npm run sync:models -- --force
 *   npm run sync:models -- --max-age-days 3
 *
 * The output `index.json` is a lookup-optimised snapshot (unique models + alias map)
 * so the app can resolve model metadata in O(1) without parsing the 4.5 MB upstream
 * catalog at runtime. The encoding itself lives in `models-dev-encode.mjs`, shared with
 * the app's own update path (hourly, and Settings → 关于), so both write the same format.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, downloadCatalog, SOURCE_URL } from "./models-dev-encode.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources", "models-dev");
const INDEX_PATH = join(OUT_DIR, "index.json");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

const args = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const existing = await readJson(INDEX_PATH);
  if (existing && !args.force) {
    console.warn(`sync-models: ${message}`);
    console.warn(`sync-models: keeping existing index (${existing.m?.length ?? 0} models)`);
    process.exit(0);
  }
  console.error(`sync-models: ${message}`);
  process.exit(1);
}

async function main() {
  const manifest = await readJson(MANIFEST_PATH);
  if (!args.force && manifest && (await isFresh(manifest))) {
    console.log(`sync-models: index is fresh (${manifest.generatedAt})`);
    return;
  }

  console.log(`sync-models: downloading ${SOURCE_URL}`);
  const index = buildSnapshot(await downloadCatalog());
  if (index.m.length === 0) throw new Error("models.dev returned no models");

  await mkdir(OUT_DIR, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(index));
  await rename(tmp, INDEX_PATH);
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify({ generatedAt: new Date(index.t).toISOString(), models: index.m.length, aliases: Object.keys(index.x).length }, null, 2)}\n`,
  );

  const bytes = Buffer.byteLength(JSON.stringify(index));
  console.log(
    `sync-models: wrote ${index.m.length} models, ${Object.keys(index.x).length} aliases (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
  );
}

async function isFresh(manifest) {
  const generated = Date.parse(manifest.generatedAt ?? "");
  if (!Number.isFinite(generated)) return false;
  const ageDays = (Date.now() - generated) / 86_400_000;
  return ageDays < args.maxAgeDays;
}

function parseArgs(argv) {
  const parsed = { force: false, maxAgeDays: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--force") parsed.force = true;
    else if (arg === "--max-age-days") parsed.maxAgeDays = Number(argv[++i] ?? 7) || 7;
    else if (arg.startsWith("--max-age-days=")) parsed.maxAgeDays = Number(arg.slice(15)) || 7;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
