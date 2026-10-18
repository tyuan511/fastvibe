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
 * The message text the platform's own `AbortError` carries.
 *
 * `AbortError` is a *name*, and the name does not survive into the transcript: the SDK
 * files a thrown error as `errorMessage: error.message`, so a reload is left with only
 * this string. Every entry is therefore matched against the **whole** message, never as
 * a substring — a gateway may answer with prose that happens to contain the word
 * "aborted", which is exactly what `isAbortOutcome` refuses to treat as proof. This is
 * presentation only: it says how a stopped run is described, never whether an error is
 * swallowed.
 */
const ABORT_ERROR_TEXTS = new Set([
  // Node: `signal.throwIfAborted()`, `AbortSignal.abort()`, and an aborted `fetch`.
  "this operation was aborted",
  "this operation has been aborted",
  // Blink / WebKit DOMException, for anything the renderer's own fetch aborts.
  "the operation was aborted",
  "the user aborted a request",
]);

export function isAbortErrorText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ABORT_ERROR_TEXTS.has(value.trim().toLowerCase().replace(/\.+$/, ""));
}

/**
 * How an assistant reply that did not finish should be described to the reader.
 *
 * The SDK records a run it aborted as `stopReason: "aborted"`, but as
 * `stopReason: "error"` when the abort surfaced as a thrown `AbortError` instead — the
 * shape a real transcript holds is an empty reply, zero usage, and Node's text. To the
 * reader those are one event: the run stopped, nothing failed. Without this the second is
 * drawn as a red failure carrying English the 界面语言 setting never got to translate,
 * beside the quiet 已中断 row the first one gets.
 */
export function assistantStopVerdict(message: unknown): "aborted" | "length" | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record.stopReason === "aborted") return "aborted";
  if (record.stopReason === "length") return "length";
  if (record.stopReason === "error") return isAbortErrorText(record.errorMessage) ? "aborted" : undefined;
  return undefined;
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
