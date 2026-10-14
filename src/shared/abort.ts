/**
 * Whether a value describes an intentional cancellation.
 *
 * Keep this structural: provider failures are allowed to mention "abort" in their
 * text without becoming cancellations. SDK stream events use `reason` / `stopReason`,
 * while fetch and other platform APIs use an `AbortError` name.
 */
export function isAbortOutcome(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  const record = value as Record<string, unknown>;
  if (record.stopReason === "aborted" || record.reason === "aborted" || record.name === "AbortError") {
    return true;
  }

  return [record.error, record.message, record.cause].some((nested) => isAbortOutcome(nested, seen));
}

/**
 * The SDK rejects a stopped compaction with this plain Error, not an AbortError.
 * A caller that toasts every rejection would report the user's own 停止 as a failure.
 */
const COMPACTION_CANCELLED = "Compaction cancelled";

export function isCompactionCancelled(value: unknown): boolean {
  if (isAbortOutcome(value)) return true;
  if (value instanceof Error) return value.message === COMPACTION_CANCELLED;
  return value === COMPACTION_CANCELLED;
}

/**
 * The `errorMessage` FastVibe writes onto a reply it stopped itself for repeating the
 * same text. The transcript records only `stopReason: "aborted"` for that and for the
 * user's own 停止, so without a mark of its own the two read identically on reload and
 * the user is never told why the run ended. The SDK persists whatever the message holds
 * when `message_end` returns, so the mark survives a reload with no side store.
 */
export const REPETITION_STOP_MESSAGE = "Stopped by FastVibe: the model fell into a repetition loop";

export function isRepetitionStop(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as Record<string, unknown>).stopReason === "aborted" &&
    (message as Record<string, unknown>).errorMessage === REPETITION_STOP_MESSAGE
  );
}
