/**
 * Whether a conversation's transcript is in a state the engine can continue from.
 *
 * This is the single verdict behind the composer's 继续 button: an abnormal stop —
 * a failure, a user abort, an output-limit truncation — leaves the transcript on a
 * message the loop can re-enter from, and Main derives that from the transcript
 * itself rather than from a live event.
 *
 * Deriving it matters because an abort is not reliably observable as an event. The
 * one that describes it (`agent_end` with `stopReason: "aborted"`) is a *transient*
 * stream payload the renderer may miss entirely — a chat on another window, a
 * reload, an event that arrived while the socket was gone. The transcript is not:
 * it survives all three, so the control reappears however the client got here.
 *
 * The rule mirrors what `continueTurn` does to re-enter the loop, because a
 * contradiction between the two is a button that either fails or lies:
 *
 * - a trailing `assistant` that did not finish — `error`, `aborted`, `length` — is
 *   dropped and the loop continues from what it was answering. A clean stop
 *   (`stop`), a tool request still `pending`, or a turn the engine deferred is a
 *   turn that *did* what it meant to, so there is nothing to resume.
 * - a trailing `user` or `toolResult` is a half-delivered turn: the prompt or the
 *   tool output went in and no reply ever came back. That is exactly what a run
 *   aborted before its first token, or a compaction that ended the process, leaves
 *   behind.
 * - anything else — an empty transcript, a `custom` message, a `compaction`
 *   summary — has no run in it to continue.
 *
 * The caller is responsible for the 「a run is already in flight」 case, and it is not
 * an edge one: `session.messages` only grows on `message_end`, so mid-run it ends on
 * whatever last finished — a `toolResult` awaiting the next round trip is the common
 * shape — and this rule calls that resumable. It *is* resumable in principle; what it
 * is not is a thing to offer while the engine is already doing it. The composer
 * therefore pairs the flag with 「this chat is idle」.
 */
export function canResumeRun(messages: readonly unknown[]): boolean {
  const last = messages[messages.length - 1];
  if (!isRecord(last)) return false;
  const role = last.role;
  if (role === "user" || role === "toolResult") return true;
  if (role !== "assistant") return false;
  const stopReason = last.stopReason;
  return stopReason === "error" || stopReason === "aborted" || stopReason === "length";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
