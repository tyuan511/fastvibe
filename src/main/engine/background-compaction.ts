import { isDeepStrictEqual } from "node:util";
import {
  createAgentSession, DefaultResourceLoader, estimateTokens, SessionManager, SettingsManager,
  type AgentSession, type CompactionResult, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { installNativeCompactionGuard } from "./native-compaction.ts";

type Options = {
  runtime: ModelRuntime;
  agentDir: string;
  onApplied: (id: string, result: CompactionResult) => void;
  isCurrent: (id: string, session: AgentSession) => boolean;
  onError?: (id: string, error: unknown) => void;
};
type Task = {
  source: AgentSession;
  branch: ReturnType<SessionManager["getBranch"]>;
  selection: string;
  snapshot?: AgentSession;
  result?: CompactionResult;
};

function selection(session: AgentSession): string {
  const model = session.model;
  return JSON.stringify([model?.id, model?.provider, model?.api, model?.baseUrl,
    model?.contextWindow, model?.maxTokens, session.thinkingLevel]);
}
function tokens(manager: SessionManager): number {
  return manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** Independent summary work; the live session is touched only by a synchronous idle apply. */
export class BackgroundCompactions {
  readonly #options: Options;
  readonly #tasks = new Map<string, Task>();

  constructor(options: Options) { this.#options = options; }

  has(id: string): boolean { return this.#tasks.has(id); }

  schedule(id: string, source: AgentSession): void {
    if (this.has(id)) return;
    try {
      if (!source.isIdle || !this.#options.isCurrent(id, source)) return;
      const header = structuredClone(source.sessionManager.getHeader());
      if (!header || !source.model) return;
      const branch = structuredClone(source.sessionManager.getBranch());
      const model = structuredClone(source.model);
      const thinkingLevel = source.thinkingLevel;
      const systemPrompt = source.systemPrompt;
      const cwd = source.sessionManager.getCwd();
      // Copy values, never the settings instance: the native guard wraps instance methods.
      const settingsManager = SettingsManager.inMemory(structuredClone(source.settingsManager.getSettings()));
      const task: Task = { source, branch, selection: selection(source) };
      this.#tasks.set(id, task);
      // Register identity before any loader/session work (including synchronous failures).
      void Promise.resolve().then(async () => {
        if (this.#tasks.get(id) !== task) return;
        try {
          const resourceLoader = new DefaultResourceLoader({
            cwd, agentDir: this.#options.agentDir, settingsManager,
            noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
            systemPrompt, systemPromptOverride: () => systemPrompt,
            appendSystemPromptOverride: () => [], agentsFilesOverride: () => ({ agentsFiles: [] }),
          });
          await resourceLoader.reload();
          if (this.#tasks.get(id) !== task) return;
          const { session } = await createAgentSession({
            cwd, agentDir: this.#options.agentDir, modelRuntime: this.#options.runtime,
            model, thinkingLevel, settingsManager, resourceLoader, tools: [],
            sessionManager: SessionManager.inMemory(cwd, undefined, [header, ...branch]),
          });
          task.snapshot = session;
          if (this.#tasks.get(id) !== task) return;
          installNativeCompactionGuard(session);
          task.result = await session.compact();
          if (this.#tasks.get(id) === task) this.apply(id);
        } catch (error) {
          if (this.#tasks.get(id) === task) {
            this.#tasks.delete(id);
            this.#log(id, error);
          }
        } finally {
          try { task.snapshot?.dispose(); } catch (error) { this.#log(id, error); }
          task.snapshot = undefined;
        }
      }).catch((error) => this.#log(id, error));
    } catch (error) { this.#log(id, error); }
  }

  apply(id: string): boolean {
    const task = this.#tasks.get(id);
    if (!task?.result) return false;
    const { source, result } = task;
    try {
      if (!this.#options.isCurrent(id, source) || selection(source) !== task.selection) {
        this.cancel(id);
        return false;
      }
      const live = source.sessionManager.getBranch();
      if (live.length < task.branch.length || !isDeepStrictEqual(live.slice(0, task.branch.length), task.branch)
        || live.slice(task.branch.length).some((entry) => ["compaction", "context_edit", "branch_summary"].includes(entry.type))) {
        this.cancel(id);
        return false;
      }
      if (!source.isIdle) return false;
      // Empty means the snapshot was fully summarized. Start retention at the first
      // newly appended entry, including hidden custom context the summary never saw.
      const boundary = result.firstKeptEntryId || live[task.branch.length]?.id || "";
      if (boundary && !live.some((entry) => entry.id === boundary)) {
        this.cancel(id);
        return false;
      }
      const preview = SessionManager.inMemory(source.sessionManager.getCwd(), undefined,
        structuredClone([source.sessionManager.getHeader()!, ...live]));
      preview.appendCompaction(result.summary, boundary, result.tokensBefore, result.details, false, result.usage);
      const after = tokens(preview);
      if (after >= tokens(source.sessionManager)) {
        this.cancel(id);
        return false;
      }
      const details = typeof result.details === "object" && result.details !== null ? result.details : {};
      const applied = { ...result, firstKeptEntryId: boundary, estimatedTokensAfter: after, details: { ...details, tokensAfter: after } };
      // No awaits: validation, append at the current leaf, and refresh are one operation.
      source.sessionManager.appendCompaction(applied.summary, boundary, applied.tokensBefore, applied.details, false, applied.usage);
      source.refreshContext();
      this.#tasks.delete(id);
      try { this.#options.onApplied(id, applied); } catch (error) { this.#log(id, error); }
      return true;
    } catch (error) {
      this.#tasks.delete(id);
      this.#log(id, error);
      return false;
    }
  }

  cancel(id: string): void {
    const task = this.#tasks.get(id);
    this.#tasks.delete(id); // Identity fence also covers cancel -> immediate reschedule.
    try { task?.snapshot?.abortCompaction(); } catch (error) { this.#log(id, error); }
  }

  clear(): void {
    for (const id of this.#tasks.keys()) this.cancel(id);
  }

  #log(id: string, error: unknown): void {
    try { this.#options.onError?.(id, error); } catch { /* Logging cannot reject background work. */ }
  }
}
