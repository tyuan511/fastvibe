import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THINKING_EFFORT_LEVELS, type CostTier, type ModelPrice, type ProviderModel, type ThinkingLevel } from "@shared/types";
import { getFastVibePaths } from "./paths";
import { defaultContextWindow } from "./context-window";

/**
 * models.dev metadata, pre-indexed at build time by `scripts/sync-models-dev.mjs` and
 * refreshable at runtime from Settings → 关于 (`models-dev-update.ts` writes the same
 * format into the app data directory, which wins over the bundled copy).
 *
 * The artifact is a compact snapshot: `m` holds unique models as tuples and
 * `x` maps every alias to an index in `m`, so lookups are a single Map hit.
 */
/** `[over, input, output, cacheRead, cacheWrite]` — one step of a price ladder. */
type CostTierTuple = [number, number, number, number, number];

/** `[input, output, cacheRead, cacheWrite, tiers?]` per million tokens. */
type CostTuple = [number, number, number, number, CostTierTuple[]?];

type ModelTuple = [
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  /** text=1 image=2 video=4 file=8 */
  inputMask: number,
  thinkingLevels: string[] | null,
  /** v4 onward. A `v <= 3` snapshot keeps the retired feature mask in this slot. */
  cost?: CostTuple,
];

type BundledIndex = {
  v: number;
  /** generatedAt epoch ms */
  t: number;
  /** upstream source url */
  s: string;
  /** model count */
  c: number;
  m: ModelTuple[];
  x: Record<string, number>;
};

export type ModelMeta = {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  thinkingLevels?: ProviderModel["thinkingLevels"];
  cost?: ProviderModel["cost"];
  /** Long-context price ladder; absent when the model charges one flat rate. */
  costTiers?: CostTier[];
  /** Provider-side names for levels pi calls something else. */
  effortMap?: ProviderModel["effortMap"];
  source: "models.dev";
};

export type ModelsDevStats = {
  models: number;
  aliases: number;
  generatedAt: number;
  source: string;
  /** The file the metadata was read from. */
  path: string;
};

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 8192;
const EFFORT_ORDER: readonly ThinkingLevel[] = THINKING_EFFORT_LEVELS;
const INPUT_DECODE: Array<[number, string]> = [
  [1, "text"],
  [2, "image"],
  [4, "video"],
  [8, "file"],
];

/** Must stay identical to `normalize` in scripts/sync-models-dev.mjs. */
export function normalizeModelKey(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function baseKey(key: string): string {
  return key.replace(/-\d{4,8}$/, "");
}

export function bundledIndexPath(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "models-dev", "index.json") : "",
    join(__dirname, "../../resources/models-dev", "index.json"),
  ];
  return candidates.find((path) => path.length > 0 && existsSync(path)) ?? null;
}

/**
 * The snapshot the user pulled from Settings → 关于. It lives in the app's own data
 * directory and wins over the bundled copy, so refreshing metadata does not need a new
 * build of the app; deleting the file falls back to the snapshot the app shipped with.
 */
export function localIndexPath(): string {
  return join(getFastVibePaths().userData, "models-dev.json");
}

export class ModelsDevIndex {
  #index: Map<string, ModelMeta>;
  readonly stats: ModelsDevStats;

  constructor(index: Map<string, ModelMeta>, stats: ModelsDevStats) {
    this.#index = index;
    this.stats = stats;
  }

  get size(): number {
    return this.stats.models;
  }

  /** O(1) lookup, trying the full id, a date-stripped id, then the last path segment. */
  lookup(id: string): ModelMeta | null {
    const norm = normalizeModelKey(id);
    const keys = [norm, baseKey(norm), normalizeModelKey(id.split("/").at(-1) ?? "")];
    for (const key of keys) {
      if (!key) continue;
      const meta = this.#index.get(key);
      if (meta) return meta;
    }
    return null;
  }
}

let cached: ModelsDevIndex | null = null;

/** Drop the memoised index, so the next read picks up a freshly written snapshot. */
export function reloadModelsDev(): void {
  cached = null;
}

export function loadModelsDev(): ModelsDevIndex {
  if (cached) return cached;
  const local = localIndexPath();
  const bundled = bundledIndexPath();
  const path = existsSync(local) ? local : bundled;
  cached = path ? readIndex(path) : new ModelsDevIndex(new Map(), emptyStats());
  // A corrupt or half-written user snapshot must not cost the app its metadata: the
  // bundled index is the copy the build actually verified.
  if (path === local && cached.size === 0 && bundled) cached = readIndex(bundled);
  return cached;
}

function readIndex(path: string): ModelsDevIndex {
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as BundledIndex;
    return new ModelsDevIndex(decode(snapshot), {
      models: snapshot.m.length,
      aliases: Object.keys(snapshot.x).length,
      generatedAt: snapshot.t,
      source: snapshot.s,
      path,
    });
  } catch {
    return new ModelsDevIndex(new Map(), emptyStats());
  }
}

function emptyStats(): ModelsDevStats {
  return { models: 0, aliases: 0, generatedAt: 0, source: "", path: "" };
}

function decode(bundled: BundledIndex): Map<string, ModelMeta> {
  const models = bundled.m.map((tuple) => toMeta(tuple, bundled.v));
  const index = new Map<string, ModelMeta>();
  for (const [alias, position] of Object.entries(bundled.x)) {
    const meta = models[position];
    if (meta) index.set(alias, meta);
  }
  return index;
}

/**
 * Where `cost` sits in a tuple. A `v <= 3` snapshot keeps the retired feature bitmask in
 * the slot the price occupies from v4 on, so reading by version stops a stale bundled
 * index from decoding a mask as prices.
 */
function costSlot(version: number): number {
  return version >= 4 ? 6 : 7;
}

function toMeta(tuple: ModelTuple, version: number): ModelMeta {
  const [, , contextWindow, maxTokens, inputMask, levels] = tuple;
  const input = INPUT_DECODE.filter(([bit]) => inputMask & bit).map(([, name]) => name);
  const efforts = decodeEfforts(levels);
  const pricing = decodeCost((tuple as unknown[])[costSlot(version)] as CostTuple | undefined);
  return {
    contextWindow: defaultContextWindow(contextWindow, pricing.costTiers),
    maxTokens: maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
    reasoning: efforts.thinkingLevels !== undefined,
    input: input.length > 0 ? input : ["text"],
    thinkingLevels: efforts.thinkingLevels,
    cost: pricing.cost,
    costTiers: pricing.costTiers,
    effortMap: efforts.effortMap,
    source: "models.dev",
  };
}

/** A v1/v2 tuple ends after the four prices; v3 appends the long-context ladder. */
function decodeCost(cost: CostTuple | undefined): ModelPrice {
  if (!cost) return {};
  const [input, output, cacheRead, cacheWrite, tiers] = cost;
  return {
    cost: { input, output, cacheRead, cacheWrite },
    costTiers: tiers?.map(([over, tierInput, tierOutput, tierCacheRead, tierCacheWrite]) => ({
      over,
      cost: { input: tierInput, output: tierOutput, cacheRead: tierCacheRead, cacheWrite: tierCacheWrite },
    })),
  };
}

/**
 * Translate the catalog's effort values into pi levels. `off` is deliberately absent:
 * it is not a capability the catalog reports but the absence of thinking, and FastVibe
 * never requests it, because an upstream whose model reasons by default rejects the
 * parameter. `xhigh` and `max` are only offered by pi when the model maps them
 * explicitly, so those mappings are recorded even when the provider names the level
 * the same way.
 */
function decodeEfforts(levels: string[] | null): {
  thinkingLevels?: ProviderModel["thinkingLevels"];
  effortMap?: ProviderModel["effortMap"];
} {
  if (!levels || levels.length === 0) return {};
  const seen: ThinkingLevel[] = [];
  const effortMap: NonNullable<ProviderModel["effortMap"]> = {};
  for (const raw of levels) {
    const level = raw as ThinkingLevel;
    if (!EFFORT_ORDER.includes(level) || seen.includes(level)) continue;
    seen.push(level);
  }
  if (seen.length === 0) return {};
  seen.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (seen.includes("xhigh")) effortMap.xhigh ??= "xhigh";
  if (seen.includes("max")) effortMap.max ??= "max";
  return {
    thinkingLevels: seen,
    effortMap: Object.keys(effortMap).length > 0 ? effortMap : undefined,
  };
}

/**
 * The bundled catalog's price for one model id, by itself — no provider needed. Used to * back-fill models stored before pricing existed and to price transcripts whose model is
 * no longer configured. `undefined` means "the catalog did not say", not "free".
 */
export function catalogPrice(id: string): ModelPrice | undefined {
  const meta = loadModelsDev().lookup(id);
  if (!meta?.cost) return undefined;
  return {
    cost: { ...meta.cost },
    costTiers: meta.costTiers?.map((tier) => ({ over: tier.over, cost: { ...tier.cost } })),
  };
}

/** Build model metadata from the bundled index, falling back to sane defaults. */
export function enrichModel(index: ModelsDevIndex, id: string, name: string): ProviderModel {
  const meta = index.lookup(id);
  if (meta) {
    return {
      id,
      name,
      contextWindow: meta.contextWindow,
      maxTokens: meta.maxTokens,
      reasoning: meta.reasoning,
      input: meta.input,
      thinkingLevels: meta.thinkingLevels,
      cost: meta.cost,
      costTiers: meta.costTiers,
      effortMap: meta.effortMap,
      source: "models.dev",
    };
  }
  return {
    id,
    name,
    contextWindow: DEFAULT_CONTEXT,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: false,
    input: ["text"],
    source: "default",
  };
}
