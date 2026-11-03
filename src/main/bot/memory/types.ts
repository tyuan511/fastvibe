export type ViviMemoryRef = { path: string; heading?: string; offset?: number; limit?: number };

/** Stable, already persisted material. Runtime state and credentials are not memory. */
export type ViviMemorySource = {
  id: string;
  conversationId: string;
  requestId: string;
  epoch: number;
  createdAt: number;
  role: "router" | "worker";
  kind: "input" | "result";
  text: string;
  title?: string;
  outcome?: string;
  evidence?: string[];
  material?: string;
};
export type ViviMemoryRead = { path: string; revision: string; content: string; offset: number; totalLines: number };
export type ViviMemoryHit = { path: string; line: number; text: string };
export type ViviMemoryContext = { root: string; revision: string; summary: string; excerpts: ViviMemoryRead[] };
export type ViviMemoryEdit = { path: string; oldText: string; newText: string };
export type ViviMemoryUpdate = {
  expectedRevision: string;
  quote: string;
  edits: ViviMemoryEdit[];
  forget?: boolean;
};
export interface ViviMemoryReader {
  context(refs?: readonly ViviMemoryRef[]): Promise<ViviMemoryContext>;
  read(path: string, offset?: number, limit?: number): Promise<ViviMemoryRead>;
  search(query: string): Promise<ViviMemoryHit[]>;
}
export interface ViviMemoryHost extends ViviMemoryReader {
  update(input: ViviMemoryUpdate, source: ViviMemorySource, valid: () => boolean): Promise<{ revision: string }>;
}
