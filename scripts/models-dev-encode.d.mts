/**
 * Types for the shared snapshot encoder (`models-dev-encode.mjs`), which the main
 * bundle imports as ESM while `scripts/sync-models-dev.mjs` runs it under bare node.
 */

/** `[id, name, contextWindow, maxTokens, inputMask, thinkingLevels, cost?]` */
export type SnapshotModelTuple = [
  string,
  string,
  number,
  number,
  number,
  string[] | null,
  unknown?,
];

export type ModelsDevSnapshot = {
  /** Snapshot format version (`SNAPSHOT_VERSION`). */
  v: number;
  /** Generated-at epoch ms. */
  t: number;
  /** Upstream source url. */
  s: string;
  /** Model count. */
  c: number;
  m: SnapshotModelTuple[];
  x: Record<string, number>;
};

export declare const SOURCE_URL: string;
export declare const SNAPSHOT_VERSION: number;

export declare function downloadCatalog(url?: string): Promise<unknown>;

export declare function buildSnapshot(
  catalog: unknown,
  options?: { source?: string; generatedAt?: number },
): ModelsDevSnapshot;

export declare function buildIndex(catalog: unknown): {
  models: SnapshotModelTuple[];
  aliases: Record<string, number>;
};

export declare function normalize(value: unknown): string;
