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
 * catalog at runtime.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources", "models-dev");
const INDEX_PATH = join(OUT_DIR, "index.json");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

/** text=1 image=2 video=4 file=8 */
const INPUT_BITS = { text: 1, image: 2, video: 4, file: 8 };
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

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
  const response = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "fastvibe-sync-models-dev" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`models.dev ${response.status} ${response.statusText}`);
  const catalog = await response.json();

  const { models, aliases } = buildIndex(catalog);
  const index = {
    // 1 = context/output/input/efforts, 2 = + cost, 3 = + cost tiers,
    // 4 = dropped the feature bitmask the UI no longer records
    v: 4,
    t: Date.now(),
    s: SOURCE_URL,
    c: models.length,
    m: models,
    x: aliases,
  };

  await mkdir(OUT_DIR, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(index));
  await rename(tmp, INDEX_PATH);
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), models: models.length, aliases: Object.keys(aliases).length }, null, 2)}\n`,
  );

  const bytes = Buffer.byteLength(JSON.stringify(index));
  console.log(
    `sync-models: wrote ${models.length} models, ${Object.keys(aliases).length} aliases (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
  );
}

function buildIndex(catalog) {
  const unique = new Map(); // normalized id -> entry
  for (const provider of Object.values(catalog ?? {})) {
    for (const model of Object.values(provider?.models ?? {})) {
      const id = model?.id ?? model?.name;
      if (!id || typeof id !== "string") continue;
      const entry = toEntry(id, model);
      const key = normalize(id);
      if (!key) continue;
      const existing = unique.get(key);
      if (!existing) {
        unique.set(key, entry);
        continue;
      }
      if (score(entry) > score(existing)) unique.set(key, entry);
    }
  }

  // Highest-quality entries claim shared aliases first.
  const ordered = [...unique.values()].sort((a, b) => score(b) - score(a));
  const aliases = {};
  const models = [];
  for (const entry of ordered) {
    const index = models.length;
    models.push(entry.tuple);
    for (const alias of aliasKeys(entry.id, entry.name)) {
      if (!(alias in aliases)) aliases[alias] = index;
    }
  }
  return { models, aliases };
}

function toEntry(id, model) {
  let mask = 0;
  for (const item of model.modalities?.input ?? []) {
    const mapped = item === "pdf" || item === "audio" ? "file" : item;
    mask |= INPUT_BITS[mapped] ?? 0;
  }
  if (mask === 0) mask = INPUT_BITS.text;
  const efforts = (model.reasoning_options ?? []).find((option) => option.type === "effort")?.values;
  const levels = Array.isArray(efforts)
    ? EFFORT_ORDER.filter((level) => efforts.includes(level))
    : model.reasoning
      ? ["low", "medium", "high"]
      : null;
  const cost = toCost(model.cost);
  const tuple = [
    id,
    model.name ?? id,
    positive(model.limit?.context),
    positive(model.limit?.output),
    mask,
    levels && levels.length > 0 ? levels : null,
    cost,
  ];
  return { id, name: model.name ?? id, tuple, scoreValue: scoreOf(id, model, mask, levels, cost) };
}

/**
 * Per-million-token prices as `[input, output, cacheRead, cacheWrite, tiers?]`, or null
 * when the catalog has no pricing (or only zeros, which carries no information).
 *
 * The first four values are the entry price — what a request at or below the first
 * threshold pays. `tiers` is the long-context ladder, `[[over, input, output,
 * cacheRead, cacheWrite], …]` ascending by `over`, and is omitted for the majority of
 * models that charge one flat rate.
 */
function toCost(cost) {
  if (!cost || typeof cost !== "object") return null;
  const base = [cost.input, cost.output, cost.cache_read, cost.cache_write].map(nonNegative);
  if (!base.some((value) => value > 0)) return null;
  const tiers = toTiers(cost, base);
  return tiers.length > 0 ? [...base, tiers] : base;
}

/**
 * The context ladder, normalised to full four-field rows. A tier that omits a field
 * (e.g. `cache_write` on an Anthropic model) keeps the entry price for it rather than
 * reading as free. `context_over_200k` is the older single-threshold spelling of the
 * same thing and is only consulted for models the catalog has not moved to `tiers`.
 */
function toTiers(cost, base) {
  const rows = Array.isArray(cost.tiers)
    ? cost.tiers.map((tier) => ({ over: positive(tier?.tier?.size), price: tier }))
    : cost.context_over_200k
      ? [{ over: 200_000, price: cost.context_over_200k }]
      : [];
  return rows
    .filter((row) => row.over > 0 && row.price && typeof row.price === "object")
    .map((row) => [
      row.over,
      priceOr(row.price.input, base[0]),
      priceOr(row.price.output, base[1]),
      priceOr(row.price.cache_read, base[2]),
      priceOr(row.price.cache_write, base[3]),
    ])
    .sort((a, b) => a[0] - b[0]);
}

function priceOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function score(entry) {
  return entry.scoreValue;
}

function scoreOf(id, model, mask, levels, cost) {
  let value = 0;
  if (levels && levels.length > 0) value += 8;
  if (model.reasoning === true) value += 4;
  value += popcount(mask);
  if (positive(model.limit?.context) >= 200_000) value += 1;
  // The catalog lists the same model under many resellers. At equal capability,
  // prefer the entry whose price list is complete, since that is what the UI shows.
  // `cost` may carry the tier ladder in slot 4, which must not count as a price.
  const prices = cost ? cost.slice(0, 4) : null;
  if (prices && prices.every((field) => field > 0)) value += 1;
  // Capability is weighted double so a declared context ladder can only break an exact
  // tie. The vendor's own entry is the one that prices long context (its resellers
  // mostly copy the base rate and drop the ladder), and without it nothing can price a
  // request above the threshold.
  return value * 2 + (hasTierLadder(cost) ? 1 : 0);
}

function hasTierLadder(cost) {
  return Array.isArray(cost) && Array.isArray(cost[4]) && cost[4].length > 0;
}

function aliasKeys(id, name) {
  const keys = new Set();
  const norm = normalize(id);
  if (norm) {
    keys.add(norm);
    const base = stripDate(norm);
    if (base) keys.add(base);
    const last = normalize(id.split("/").at(-1) ?? "");
    if (last) {
      keys.add(last);
      keys.add(stripDate(last));
    }
  }
  const normName = normalize(name ?? "");
  if (normName) keys.add(normName);
  return [...keys].filter(Boolean);
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function stripDate(key) {
  return key.replace(/-\d{4,8}$/, "");
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function popcount(value) {
  let count = 0;
  let n = value;
  while (n) {
    n &= n - 1;
    count += 1;
  }
  return count;
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
