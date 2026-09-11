import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderModel } from "@shared/types";

/**
 * models.dev metadata, pre-indexed at build time by `scripts/sync-models-dev.mjs`.
 *
 * The bundled artifact is a compact snapshot: `m` holds unique models as tuples and
 * `x` maps every alias to an index in `m`, so lookups are a single Map hit.
 */
type ModelTuple = [
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  /** text=1 image=2 video=4 file=8 */
  inputMask: number,
  thinkingLevels: string[] | null,
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
  source: "models.dev";
};

export type ModelsDevStats = {
  models: number;
  aliases: number;
  generatedAt: number;
  source: string;
  path: string;
};

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 8192;
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
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

export function loadModelsDev(): ModelsDevIndex {
  if (cached) return cached;
  const path = bundledIndexPath();
  if (!path) {
    cached = new ModelsDevIndex(new Map(), {
      models: 0,
      aliases: 0,
      generatedAt: 0,
      source: "",
      path: "",
    });
    return cached;
  }
  try {
    const bundled = JSON.parse(readFileSync(path, "utf8")) as BundledIndex;
    cached = new ModelsDevIndex(decode(bundled), {
      models: bundled.m.length,
      aliases: Object.keys(bundled.x).length,
      generatedAt: bundled.t,
      source: bundled.s,
      path,
    });
  } catch {
    cached = new ModelsDevIndex(new Map(), { models: 0, aliases: 0, generatedAt: 0, source: "", path });
  }
  return cached;
}

function decode(bundled: BundledIndex): Map<string, ModelMeta> {
  const models = bundled.m.map(toMeta);
  const index = new Map<string, ModelMeta>();
  for (const [alias, position] of Object.entries(bundled.x)) {
    const meta = models[position];
    if (meta) index.set(alias, meta);
  }
  return index;
}

function toMeta(tuple: ModelTuple): ModelMeta {
  const [, , contextWindow, maxTokens, inputMask, levels] = tuple;
  const input = INPUT_DECODE.filter(([bit]) => inputMask & bit).map(([, name]) => name);
  const efforts = levels
    ?.filter((level) => EFFORT_ORDER.includes(level))
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    .map((level) => level as NonNullable<ProviderModel["thinkingLevels"]>[number]);
  return {
    contextWindow: contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT,
    maxTokens: maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
    reasoning: efforts != null && efforts.length > 0,
    input: input.length > 0 ? input : ["text"],
    thinkingLevels: efforts && efforts.length > 0 ? efforts : undefined,
    source: "models.dev",
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
