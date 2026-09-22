import type { QueuePauseReason } from "@shared/types";

/**
 * Capture whether Send belongs to Main's durable queue before any IPC hop.
 *
 * A stopped run is not itself a reason to queue the next fresh prompt: once the
 * run has settled, that prompt should start a new run. An existing queue still
 * wins, and an error pause stays paused until the user explicitly resumes it.
 * `stopConfirmed` covers the small window where Main has finished stopping but
 * the renderer has not received its `conversation_running: false` push yet.
 */
export function shouldQueueSubmission(input: {
  hasConversation: boolean;
  running: boolean;
  pauseReason: QueuePauseReason | null;
  hasQueuedItems: boolean;
  stopConfirmed?: boolean;
}): boolean {
  if (!input.hasConversation) return false;
  if (input.hasQueuedItems) return true;
  if (input.stopConfirmed) return false;
  return input.running || input.pauseReason === "error";
}

/** An async reservation may restore a composer only while nobody has edited it. */
export function canRestoreComposer(currentVersion: number | undefined, expectedVersion: number): boolean {
  return currentVersion === expectedVersion;
}
