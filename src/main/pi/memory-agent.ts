import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ModelRegistry,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { FastVibePaths } from "../engine/paths";

/**
 * Tools the consolidation agent may use. No `bash`: the job is reading and editing Markdown
 * in one folder, and a shell is the one tool that could reach outside it or the network.
 */
export const MEMORY_AGENT_TOOLS = ["read", "edit", "write", "grep", "find", "ls"];

/** Cut a runaway consolidation off; a normal pass is a handful of file edits. */
const MEMORY_AGENT_TIMEOUT_MS = 10 * 60_000;

/**
 * Run the consolidation agent: a throwaway in-memory session whose workspace is the memory
 * folder, given Codex's consolidation prompt as its one user message, with no FastVibe extension loaded (no recursion, no memory read for the thing
 * that writes memory) and nobody to ask — a prompt it raised would have no panel.
 */
export async function runMemoryAgent(
  host: { runtime: ModelRuntime; models: ModelRegistry; paths: FastVibePaths; model: ReturnType<ModelRegistry["find"]> },
  request: { cwd: string; task: string; signal?: AbortSignal },
): Promise<void> {
  if (!host.model) throw new Error("no model is available for memory consolidation");
  const settingsManager = SettingsManager.create(request.cwd, host.paths.agentDir);
  const loader = new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir: host.paths.agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    noSkills: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: request.cwd,
    agentDir: host.paths.agentDir,
    modelRuntime: host.runtime,
    sessionManager: SessionManager.inMemory(request.cwd),
    settingsManager,
    resourceLoader: loader,
    tools: MEMORY_AGENT_TOOLS,
    model: host.model,
    // Codex runs consolidation at medium reasoning.
    thinkingLevel: "medium",
  });
  const stop = (): void => { void session.abort().catch(() => undefined); };
  const timer = setTimeout(stop, MEMORY_AGENT_TIMEOUT_MS);
  request.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (request.signal?.aborted) return;
    await session.prompt(request.task);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", stop);
    session.dispose();
  }
}
