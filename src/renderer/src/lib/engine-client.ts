import { useSessionStore } from "@/stores/session";
import type { ChatMessage, ConversationOpenResult, EngineSessionState, PromptImage, SessionStats, TranscriptTail } from "@shared/types";

type FastVibeEngine = typeof window.fastvibe.engine;

/**
 * The engine's per-conversation calls, addressed to the chat this window has open.
 *
 * Main keeps one `AgentSession` per conversation, but the IPC channels used to say
 * only *what* to do, never *which chat* — every call resolved against one engine-wide
 * active id. That is correct for a single window and wrong the moment there are two:
 * each window has its own idea of the open chat, and whichever window called
 * `conversations.open` last owned the engine's active id, so a prompt typed in one
 * window was delivered to the other window's conversation.
 *
 * So every call that acts on a conversation now carries its id. The store's `activeId`
 * is the one this window means, read at call time rather than captured, so a switch
 * mid-flight routes the next call to the new chat. Callers that mean a *different*
 * chat (archiving a background run) pass the id explicitly.
 *
 * The engine still accepts an omitted id and falls back to its own active
 * conversation, which keeps the no-conversation case — the empty hero, settings, the
 * first prompt of a brand-new chat — working without a special branch here.
 */
function activeId(): string | undefined {
  return useSessionStore.getState().activeId ?? undefined;
}

export const engine = {
  prompt: (
    message: string,
    options?: { streamingBehavior?: "steer" | "followUp"; images?: PromptImage[]; conversationId?: string },
  ): Promise<void> =>
    window.fastvibe.engine.prompt(message, {
      streamingBehavior: options?.streamingBehavior,
      images: options?.images,
      conversationId: options?.conversationId ?? activeId(),
    }),

  steer: (message: string, images?: PromptImage[], conversationId?: string): Promise<void> =>
    window.fastvibe.engine.steer(message, images, conversationId ?? activeId()),

  followUp: (message: string, images?: PromptImage[], conversationId?: string): Promise<void> =>
    window.fastvibe.engine.followUp(message, images, conversationId ?? activeId()),

  /** Stop one chat. Called with no id it stops the one on screen (the composer, Escape). */
  abort: (conversationId?: string): Promise<void> =>
    window.fastvibe.engine.abort(conversationId ?? activeId()),

  continue: (conversationId?: string): Promise<void> =>
    window.fastvibe.engine.continue(conversationId ?? activeId()),

  clearQueue: (conversationId?: string): Promise<{ steering: string[]; followUp: string[] }> =>
    window.fastvibe.engine.clearQueue(conversationId ?? activeId()),

  replaceSteering: (
    items: Array<{ text: string; images?: PromptImage[] }>,
    conversationId?: string,
  ): Promise<void> => window.fastvibe.engine.replaceSteering(items, conversationId ?? activeId()),

  compact: (customInstructions?: string, conversationId?: string): Promise<EngineSessionState> =>
    window.fastvibe.engine.compact(customInstructions, conversationId ?? activeId()),

  branch: (entryId: string, conversationId?: string): Promise<ChatMessage[]> =>
    window.fastvibe.engine.branch(entryId, conversationId ?? activeId()),

  /** Copy a chat at an entry (or its current tip) without rewinding the source chat. */
  fork: (entryId?: string, conversationId?: string): Promise<ConversationOpenResult> =>
    window.fastvibe.engine.fork(entryId, conversationId ?? activeId()),

  getMessages: (conversationId?: string): Promise<ChatMessage[]> =>
    window.fastvibe.engine.getMessages(conversationId ?? activeId()),

  getMessagesSince: (anchorEntryId: string, conversationId?: string): Promise<TranscriptTail> =>
    window.fastvibe.engine.getMessagesSince(anchorEntryId, conversationId ?? activeId()),

  getStats: (conversationId?: string): Promise<SessionStats> =>
    window.fastvibe.engine.getStats(conversationId ?? activeId()),

  getState: (conversationId?: string): Promise<EngineSessionState> =>
    window.fastvibe.engine.getState(conversationId ?? activeId()),

  setModel: (provider: string, modelId: string, conversationId?: string): Promise<EngineSessionState> =>
    window.fastvibe.engine.setModel(provider, modelId, conversationId ?? activeId()),

  setThinking: (level: string, conversationId?: string): Promise<EngineSessionState> =>
    window.fastvibe.engine.setThinking(level, conversationId ?? activeId()),
};

/**
 * The calls that carry no conversation: they are about the install, not a chat.
 *
 * Wrapped rather than destructured at module scope. A module-scope `const { x } =
 * window.fastvibe.engine` runs the moment this file is imported — before React mounts,
 * and therefore outside any error boundary — so a build where the preload bridge is not
 * up yet would throw during module evaluation and leave a blank window with nothing to
 * catch it. Reading the bridge per call moves that failure inside the tree.
 */
export const onEvent: FastVibeEngine["onEvent"] = (...args) => window.fastvibe.engine.onEvent(...args);
export const onStatus: FastVibeEngine["onStatus"] = (...args) => window.fastvibe.engine.onStatus(...args);
export const onConversationReady: FastVibeEngine["onConversationReady"] = (...args) =>
  window.fastvibe.engine.onConversationReady(...args);
export const respondPermission: FastVibeEngine["respondPermission"] = (...args) =>
  window.fastvibe.engine.respondPermission(...args);
/**
 * Newly session-scoped (parent must route by `conversationId`, including a namespaced
 * remote id): `getCommands`, `getModels`, `getSubagents`, `getSubagentMessages`,
 * `abortSubagent`. Previously they hit whichever engine was active on this machine.
 */
export const getCommands: FastVibeEngine["getCommands"] = (conversationId) =>
  window.fastvibe.engine.getCommands(conversationId ?? activeId());
export const getModels: FastVibeEngine["getModels"] = (conversationId) =>
  window.fastvibe.engine.getModels(conversationId ?? activeId());
export const getStatus: FastVibeEngine["getStatus"] = (...args) => window.fastvibe.engine.getStatus(...args);
export const start: FastVibeEngine["start"] = (...args) => window.fastvibe.engine.start(...args);
export const stop: FastVibeEngine["stop"] = (...args) => window.fastvibe.engine.stop(...args);
export const setInterruptMode: FastVibeEngine["setInterruptMode"] = (mode, conversationId) =>
  window.fastvibe.engine.setInterruptMode(mode, conversationId ?? activeId());
export const setAutoCompaction: FastVibeEngine["setAutoCompaction"] = (enabled, conversationId) =>
  window.fastvibe.engine.setAutoCompaction(enabled, conversationId ?? activeId());
export const setSteeringMode: FastVibeEngine["setSteeringMode"] = (mode, conversationId) =>
  window.fastvibe.engine.setSteeringMode(mode, conversationId ?? activeId());
export const setFollowUpMode: FastVibeEngine["setFollowUpMode"] = (mode, conversationId) =>
  window.fastvibe.engine.setFollowUpMode(mode, conversationId ?? activeId());
export const exportHtml: FastVibeEngine["exportHtml"] = (...args) => window.fastvibe.engine.exportHtml(...args);
export const abortSubagent: FastVibeEngine["abortSubagent"] = (subagentId, conversationId) =>
  window.fastvibe.engine.abortSubagent(subagentId, conversationId ?? activeId());
export const getSubagents: FastVibeEngine["getSubagents"] = (conversationId) =>
  window.fastvibe.engine.getSubagents(conversationId ?? activeId());
export const getSubagentMessages: FastVibeEngine["getSubagentMessages"] = (subagentId, conversationId) =>
  window.fastvibe.engine.getSubagentMessages(subagentId, conversationId ?? activeId());
export const getCheckpoint: FastVibeEngine["getCheckpoint"] = (conversationId) =>
  window.fastvibe.engine.getCheckpoint(conversationId);
export const restoreCheckpoint: FastVibeEngine["restoreCheckpoint"] = (conversationId) =>
  window.fastvibe.engine.restoreCheckpoint(conversationId);
export const newSession: FastVibeEngine["newSession"] = (...args) => window.fastvibe.engine.newSession(...args);
export const getRunning: FastVibeEngine["getRunning"] = (...args) => window.fastvibe.engine.getRunning(...args);
export const promptConversation: FastVibeEngine["promptConversation"] = (...args) =>
  window.fastvibe.engine.promptConversation(...args);
export const getConversationMessages: FastVibeEngine["getConversationMessages"] = (...args) =>
  window.fastvibe.engine.getConversationMessages(...args);
