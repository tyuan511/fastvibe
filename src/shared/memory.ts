import type { EngineModel } from "./types.ts";

/** The three memory paths exposed by FastVibe. */
export type MemoryMode = "default" | "semantic" | "jev";

export type MemoryEmbeddingProvider = "local-minilm-multilingual-q8";

export type MemoryTypeScores = {
  episodic: number;
  semantic: number;
  procedural: number;
  preference: number;
};

export type MemoryRelationView = "semantic" | "temporal" | "causal" | "entity";

export type MemoryConfig = {
  /** Kept in the wire shape for compatibility; Default memory is always enabled. */
  enabled: boolean;
  /** `default` is model-free; `semantic` adds local embeddings; `jev` adds Jev decisions. */
  mode: MemoryMode;
  /** Capture final user and assistant turns automatically. */
  autoCapture: boolean;
  embeddingProvider: MemoryEmbeddingProvider;
  maxResults: number;
  maxContextChars: number;
  /** Explicit System-Two model used for JEV memory consolidation. */
  systemTwoModel?: EngineModel;
};

export type MemoryModelState = {
  provider: MemoryEmbeddingProvider;
  status: "not-installed" | "downloading" | "ready" | "error";
  progress?: number;
  /** Bytes fetched so far and the download's total, across every model file; set while downloading. */
  loadedBytes?: number;
  totalBytes?: number;
  error?: string;
  /** Approximate on-disk size reported by the model loader when available. */
  sizeBytes?: number;
};

export type MemoryState = {
  config: MemoryConfig;
  model: MemoryModelState;
  items: number;
  edges: number;
};

export type MemorySearchRequest = {
  query: string;
  conversationId?: string;
  project?: string;
  limit?: number;
};

export type MemoryItem = {
  id: string;
  conversationId?: string;
  project?: string;
  role: "user" | "assistant" | "fact" | "entity" | "summary";
  kind: "fact" | "preference" | "task" | "episode" | "entity" | "procedural" | "semantic" | "other";
  content: string;
  createdAt: number;
  importance: number;
  confidence: number;
  /** Overlapping Jev-Mem type scores, retained alongside the original observation. */
  typeScores?: MemoryTypeScores;
  /** Deterministic entity identifiers used for candidate discovery and entity edges. */
  entities?: string[];
  sourceEntryId?: string;
  metadata?: Record<string, unknown>;
  score?: number;
};

/**
 * Which stage made an edge, after the Jev-Mem reference: `jev` the write-time Jev
 * relations, `sequence` the write-time temporal links, `consolidation` periodic
 * consolidation, `magma` the fallback write when a Jev call fails.
 */
export type MemoryEdgeOrigin = "jev" | "sequence" | "consolidation" | "magma";

export type MemoryEdge = {
  sourceId: string;
  targetId: string;
  view: MemoryRelationView;
  /** Defaults to `jev`. Edges of different origins between one pair coexist. */
  origin?: MemoryEdgeOrigin;
  relation: "supports" | "contradicts" | "elaborates" | "duplicates" | "temporally_close" | "same_episode" | "same_entity" | "related" | "before" | "after" | "during" | "contains" | "overlaps" | "same_time" | "causes" | "caused_by" | "unknown" | "none";
  weight: number;
  confidence?: number;
};

/** 设置 → 长期记忆 → 关系图: which memories to draw. */
export type MemoryGraphRequest = {
  /** One project's memories; omitted for every project. */
  project?: string;
  limit?: number;
};

/** The newest memories the graph draws at most; older ones are counted, not drawn. */
export const MEMORY_GRAPH_LIMIT = 300;

/** A memory as the graph draws it: enough to place, colour and label it. */
export type MemoryGraphNode = {
  id: string;
  role: MemoryItem["role"];
  kind: MemoryItem["kind"];
  createdAt: number;
  /** The first characters of the content. */
  preview: string;
  project?: string;
  conversationId?: string;
  /** Written by the fallback path when a Jev call failed. */
  fallback?: boolean;
};

export type MemoryGraphEdge = {
  sourceId: string;
  targetId: string;
  view: MemoryRelationView;
  relation: MemoryEdge["relation"];
  origin: MemoryEdgeOrigin;
  weight: number;
};

export type MemoryGraph = {
  nodes: MemoryGraphNode[];
  /** Edges whose both ends are among `nodes`. */
  edges: MemoryGraphEdge[];
  /** Projects that hold memories, most recently written first. */
  projects: string[];
  /** Memories in the requested scope, drawn or not. */
  total: number;
};

/** One memory in full, with every edge that touches it. */
export type MemoryDetail = {
  item: MemoryItem & { keywords?: string[] };
  relations: Array<{ edge: MemoryGraphEdge; direction: "out" | "in"; neighbor: MemoryGraphNode }>;
};

export type MemorySearchResult = {
  items: MemoryItem[];
  mode: MemoryMode;
  usedEmbedding: boolean;
  usedJev: boolean;
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  mode: "default",
  autoCapture: true,
  embeddingProvider: "local-minilm-multilingual-q8",
  maxResults: 8,
  maxContextChars: 6_000,
  systemTwoModel: undefined,
};

export function memoryConfigOf(value: unknown): MemoryConfig {
  if (typeof value !== "object" || value === null) return DEFAULT_MEMORY_CONFIG;
  const input = value as Partial<MemoryConfig>;
  // Older builds stored `{ enabled: false, mode: "semantic" }` before the
  // model-free Default mode existed. Migrate that state without starting a
  // surprise model download; users can opt into Semantic memory explicitly.
  const mode = input.enabled === false
    ? "default"
    : input.mode === "semantic" || input.mode === "jev" ? input.mode : "default";
  return {
    enabled: true,
    mode,
    autoCapture: input.autoCapture !== false,
    embeddingProvider: "local-minilm-multilingual-q8",
    maxResults: clampInt(input.maxResults, 1, 32, DEFAULT_MEMORY_CONFIG.maxResults),
    maxContextChars: clampInt(input.maxContextChars, 1_000, 20_000, DEFAULT_MEMORY_CONFIG.maxContextChars),
    ...(isEngineModel(input.systemTwoModel) ? { systemTwoModel: input.systemTwoModel } : {}),
  };
}

function isEngineModel(value: unknown): value is EngineModel {
  return typeof value === "object" && value !== null
    && typeof (value as EngineModel).provider === "string"
    && typeof (value as EngineModel).id === "string"
    && (value as EngineModel).provider.length > 0
    && (value as EngineModel).id.length > 0;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}
