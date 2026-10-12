import type { EngineModel } from "./types.ts";

/**
 * Long-term memory, after Codex's: one switch. On, FastVibe distills finished conversations
 * into a small set of files and puts the summary in front of the agent; off, there is
 * no memory at all. Nothing else is configurable on purpose — see `docs/memory.md`.
 */
export type MemoryConfig = {
  enabled: boolean;
  /** The model that reads conversations and consolidates them. Absent: the default model. */
  model?: EngineModel;
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { enabled: false };

/** What the pipeline is doing right now, for the settings row. */
export type MemoryPhase = "idle" | "extracting" | "consolidating";

export type MemoryState = {
  config: MemoryConfig;
  phase: MemoryPhase;
  /** Conversations distilled so far (stage-1 outputs kept). */
  conversations: number;
  /** Conversations waiting to be distilled once they have been idle long enough. */
  pending: number;
  /** True once consolidation has produced a summary the agent can read. */
  ready: boolean;
  lastRunAt?: number;
  /** The last pass's failure, cleared by the next success. */
  error?: string;
  /** Where the files live, so the settings pane can reveal the folder. */
  folder: string;
};

export function memoryConfigOf(value: unknown): MemoryConfig {
  if (typeof value !== "object" || value === null) return DEFAULT_MEMORY_CONFIG;
  // Files from the three-mode era carried `mode`, an embedding model and retention knobs;
  // they were always on, so only an explicit `enabled: true` written by this version counts.
  const input = value as { enabled?: unknown; version?: unknown; model?: unknown };
  const model = input.model as Partial<EngineModel> | undefined;
  const pinned = typeof model?.provider === "string" && typeof model.id === "string" && model.provider && model.id
    ? { provider: model.provider, id: model.id }
    : undefined;
  return { enabled: input.version === MEMORY_CONFIG_VERSION && input.enabled === true, ...(pinned ? { model: pinned } : {}) };
}

/** Marks a `memory.json` written by the file-based memory, as opposed to the retired modes. */
export const MEMORY_CONFIG_VERSION = 2;
