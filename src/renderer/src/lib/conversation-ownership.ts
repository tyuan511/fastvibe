import type { EngineEvent, EngineSessionState } from "../../../shared/types.ts";

/** Draft state belongs only to the hero, never to an already open conversation. */
export function sessionBelongsToConversation(session: EngineSessionState | null, ownerId: string | null): boolean {
  return session === null || (session.conversationId ?? null) === ownerId;
}

/** Re-check coalesced events at flush time, not just at delivery time. */
export function belongsToTranscript(event: EngineEvent, ownerId: string | null): boolean {
  // These update maps keyed by conversation/run rather than the visible transcript.
  if (event.type.startsWith("subagent_")) return true;
  if (event.type === "extension_ui_dismiss") return true;
  if (event.type === "extension_ui_request" && event.method !== "set_editor_text") return true;
  const conversationId = typeof event.conversationId === "string" ? event.conversationId : null;
  // Unattributed events are not permission to write into whichever chat is visible.
  return conversationId === ownerId;
}
