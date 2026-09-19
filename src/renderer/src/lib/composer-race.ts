/**
 * Capture whether Send belongs to Main's durable queue before any IPC hop.
 * A paused or already-populated queue stays a queue even after its run settles.
 */
export function shouldQueueSubmission(input: {
  hasConversation: boolean;
  running: boolean;
  paused: boolean;
  hasQueuedItems: boolean;
}): boolean {
  return input.hasConversation && (input.running || input.paused || input.hasQueuedItems);
}

/** An async reservation may restore a composer only while nobody has edited it. */
export function canRestoreComposer(currentVersion: number | undefined, expectedVersion: number): boolean {
  return currentVersion === expectedVersion;
}
