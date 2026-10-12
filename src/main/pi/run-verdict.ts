/**
 * Why the run in flight is ending, held until `agent_settled` reads it.
 *
 * `stopped` and `handoff` are *asked for* — the user's 停止, and 立即 stopping the
 * reply so the next queued message can run. `error` is *read off the reply*: an
 * attempt that ended on a failure, an abort nobody here asked for, or the output
 * limit.
 */
export type RunVerdict = "stopped" | "error" | "handoff";

/**
 * The verdict once a new attempt (`agent_start` / `turn_start`) begins.
 *
 * Only a verdict read off a reply is dropped: the attempt it described was followed
 * by another one (a retry, a continuation), so it no longer says how the run ends.
 * A verdict somebody asked for outlives the event, and it has to: aborting a run in
 * the middle of a tool call makes the agent loop close that tool's turn and open one
 * more — `turn_start` — before it reads the abort and ends. Clearing the request
 * there left the aborted reply to be read as a failure, so 立即 paused the queue with
 * 「当前响应出错」 over the very message it was sending, and a plain 停止 was reported as
 * a failed task.
 */
export function verdictAfterStart(current: RunVerdict | undefined): RunVerdict | undefined {
  return current === "error" ? undefined : current;
}

/** The verdict after an attempt's `agent_end`, given how its last reply stopped. */
export function verdictAfterEnd(current: RunVerdict | undefined, stopReason: string | undefined): RunVerdict | undefined {
  if (current === "stopped" || current === "handoff") return current;
  return stopReason === "error" || stopReason === "aborted" || stopReason === "length" ? "error" : current;
}
