import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Conversation, EngineModel } from "@shared/types";
import type { MemoryConfig, MemoryState } from "../../shared/memory.ts";

/** What the engine lends the memory pipeline: the catalog, transcripts and a model. */
export type MemoryRuntime = {
  conversations(): Conversation[];
  /** The current branch of a persisted transcript, read without ever writing to it. */
  loadBranch(file: string, cwd: string): Promise<SessionEntry[]>;
  /** One model call outside any conversation. Rejects when no model is usable. */
  complete(system: string, user: string, signal?: AbortSignal, model?: EngineModel): Promise<string>;
  /** How much transcript one extraction may read: 70% of the background model's window, as Codex budgets it. */
  inputBudgetChars(model?: EngineModel): number;
  /** Run an agent on `task` to completion with `cwd` as its only workspace. */
  runAgent(request: { cwd: string; task: string; signal?: AbortSignal; model?: EngineModel }): Promise<void>;
};

/** The memory surface the engine needs; the implementation stays out of the Agent's graph. */
export interface MemoryHost {
  readonly config: MemoryConfig;
  state(): MemoryState;
  onChange(listener: (state: MemoryState) => void): () => void;
  attach(runtime: MemoryRuntime | null): void;
  setConfig(patch: unknown): Promise<MemoryState>;
  /** Run one extraction/consolidation pass now. */
  run(): Promise<MemoryState>;
  clear(): Promise<MemoryState>;
  extension(): ExtensionFactory;
  /** A finished reply, for the citation block it may carry. */
  noteReply(text: string): void;
}

/** Used by the SSH Agent, which deliberately has no local memory service. */
export class DisabledMemoryHost implements MemoryHost {
  readonly config = { enabled: false } satisfies MemoryConfig;

  state(): MemoryState {
    return { config: this.config, phase: "idle", conversations: 0, pending: 0, ready: false, folder: "" };
  }

  onChange(_listener: (state: MemoryState) => void): () => void { return () => undefined; }
  attach(_runtime: MemoryRuntime | null): void { /* memory is disabled */ }
  async setConfig(_patch: unknown): Promise<MemoryState> { return this.state(); }
  async run(): Promise<MemoryState> { return this.state(); }
  async clear(): Promise<MemoryState> { return this.state(); }
  extension(): ExtensionFactory { return async () => undefined; }
  noteReply(_text: string): void { /* memory is disabled */ }
}
