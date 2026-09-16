import type { ImportSourceId } from "@shared/types";

/**
 * The shape every source adapter produces, and the only thing the writer knows how
 * to turn into a session file.
 *
 * Adapters never build pi entries themselves. They translate their source into this
 * intermediate form and stop: the ordering rules that make a transcript valid (a tool
 * result directly after the assistant that called it, a linear parent chain, no foreign
 * thinking signatures) live in one writer, so a new adapter cannot get them wrong.
 * See `docs/import-from-other-agents.md` §2.4 for why each rule exists.
 */
export type ImportedSession = {
  source: ImportSourceId;
  /** Session id inside the source; with `source`, the re-import key. */
  sourceId: string;
  title: string;
  /** Working directory recorded by the source agent — may no longer exist on disk. */
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  /** Model the source last used, written as a leading `model_change` for usage fallback. */
  model?: { provider: string; model: string };
  items: ImportedItem[];
  /** Human-readable list of what was dropped, shown in the import report. */
  skipped: string[];
};

export type ImportedImage = { data: string; mimeType: string };

export type ImportedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type ImportedToolCall = {
  id: string;
  name: string;
  args: unknown;
  /**
   * The tool's output. `undefined` means the source never recorded one (the run was
   * interrupted), which the writer turns into an explicit error result — a tool call
   * with no result would be rejected by the provider on the next real turn.
   */
  result?: { text: string; isError: boolean; at?: number };
};

export type ImportedItem =
  | { kind: "user"; text: string; images?: ImportedImage[]; at: number }
  | {
      kind: "assistant";
      text: string;
      /** Reasoning text. Signatures are deliberately not carried across sources. */
      thinking: string[];
      toolCalls: ImportedToolCall[];
      model?: string;
      provider?: string;
      usage?: ImportedUsage;
      at: number;
    };

/** A source that can be scanned and read. Both methods must treat foreign data as read-only. */
export type ImportAdapter = {
  id: ImportSourceId;
  name: string;
  /** Where the adapter looks, for the 导入 pane's empty state. */
  root: string;
  scan(): Promise<ImportCandidateInfo[]>;
  read(id: string): Promise<ImportedSession>;
  /**
   * Release anything a run cached (a copied database, a temporary directory). Called
   * once after the import finishes, so a source can keep resources between `scan()` and
   * its `read()` calls without leaking them.
   */
  dispose?(): Promise<void>;
};

export type ImportCandidateInfo = {
  id: string;
  title: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Messages the session holds, when the adapter can count them without parsing every
   * file in the source. Codex leaves this out: counting means reading 1000+ rollouts,
   * and the picker must open in milliseconds. Callers must tolerate it being absent.
   */
  messageCount?: number;
  /** Transcript bytes on disk, when the source knows it without reading every payload. */
  bytes?: number;
  note?: string;
};
