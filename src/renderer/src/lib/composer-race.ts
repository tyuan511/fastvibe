/**
 * Capture whether Send belongs to Main's durable queue before any IPC hop.
 *
 * Anything already queued means Send queues too, idle or not, preserving order: a
 * paused queue holds new input with it until the user releases it (立即 / 继续发送).
 * With an empty queue only a live run queues; a leftover pause never captures input.
 * `stopConfirmed` covers the small window where Main has finished stopping but
 * the renderer has not received its `conversation_running: false` push yet.
 */
export function shouldQueueSubmission(input: {
  hasConversation: boolean;
  running: boolean;
  hasQueuedItems: boolean;
  stopConfirmed?: boolean;
}): boolean {
  if (!input.hasConversation) return false;
  if (input.hasQueuedItems) return true;
  if (input.stopConfirmed) return false;
  return input.running;
}

/** An async reservation may restore a composer only while nobody has edited it. */
export function canRestoreComposer(currentVersion: number | undefined, expectedVersion: number): boolean {
  return currentVersion === expectedVersion;
}
