import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
  MemoryConfig,
  MemoryDetail,
  MemoryGraph,
  MemoryGraphRequest,
  MemoryItem,
  MemoryModelState,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryState,
} from "@shared/memory";
import type { EngineModel } from "@shared/types";

/** The memory surface the engine needs; the implementation stays out of Agent's graph. */
export interface MemoryHost {
  readonly config: MemoryConfig;
  state(): MemoryState;
  onChange(listener: (state: MemoryState) => void): () => void;
  setSystemTwoGenerator(generator: ((conversationId: string, model: EngineModel, system: string, user: string, signal?: AbortSignal) => Promise<string>) | null): void;
  setConfig(patch: unknown): Promise<MemoryState>;
  prepareModel(): Promise<MemoryState>;
  search(request: MemorySearchRequest): Promise<MemorySearchResult>;
  graph(request?: MemoryGraphRequest): MemoryGraph;
  detail(id: string): MemoryDetail | undefined;
  delete(id: string): MemoryState;
  clear(): MemoryState;
  extension(conversationId: string, project?: string): ExtensionFactory;
  capture(input: {
    conversationId?: string;
    project?: string;
    role: "user" | "assistant";
    content: string;
    sourceEntryId?: string;
  }): Promise<MemoryItem | undefined>;
}

/** Used by the SSH Agent, which deliberately has no local memory service. */
export class DisabledMemoryHost implements MemoryHost {
  readonly config = {
    enabled: false,
    mode: "default" as const,
    autoCapture: false,
    embeddingProvider: "local-minilm-multilingual-q8",
    maxResults: 0,
    maxContextChars: 0,
  } satisfies MemoryConfig;

  state(): MemoryState {
    return {
      config: this.config,
      model: { provider: "local-minilm-multilingual-q8", status: "not-installed" } satisfies MemoryModelState,
      items: 0,
      edges: 0,
    };
  }

  onChange(_listener: (state: MemoryState) => void): () => void { return () => undefined; }
  setSystemTwoGenerator(_generator: ((conversationId: string, model: EngineModel, system: string, user: string, signal?: AbortSignal) => Promise<string>) | null): void { /* memory is disabled */ }
  async setConfig(_patch: unknown): Promise<MemoryState> { return this.state(); }
  async prepareModel(): Promise<MemoryState> { return this.state(); }
  async search(_request: MemorySearchRequest): Promise<MemorySearchResult> {
    return { items: [], mode: "default", usedEmbedding: false, usedJev: false };
  }
  graph(_request: MemoryGraphRequest = {}): MemoryGraph {
    return { nodes: [], edges: [], projects: [], total: 0 };
  }
  detail(_id: string): MemoryDetail | undefined { return undefined; }
  delete(_id: string): MemoryState { return this.state(); }
  clear(): MemoryState { return this.state(); }
  extension(_conversationId: string, _project?: string): ExtensionFactory {
    return async () => undefined;
  }
  async capture(_input: Parameters<MemoryHost["capture"]>[0]): Promise<MemoryItem | undefined> { return undefined; }
}
