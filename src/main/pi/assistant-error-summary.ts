export type AssistantErrorSummary = {
  role: "assistant";
  stopReason: "error" | "aborted" | "length";
  errorMessage: unknown;
};

/**
 * Keep only the terminal fields the renderer needs from an assistant message that did
 * not finish: a failure, an abort, or an output-limit truncation. `length` is kept too —
 * stripping it left the renderer no way to say a reply was cut off, so the run just
 * stopped mid-sentence with nothing on screen.
 */
export function assistantErrorSummary(message: unknown): AssistantErrorSummary | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  if (record.stopReason !== "error" && record.stopReason !== "aborted" && record.stopReason !== "length") return undefined;
  return {
    role: "assistant",
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
  };
}

/**
 * Summarise the current final assistant message, not the newest historical failure.
 * A successful retry leaves failed attempts earlier in the transcript; those must not
 * be reported again when the completed run emits its final `agent_end`.
 */
export function finalAssistantErrorSummary(messages: unknown[]): AssistantErrorSummary | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    if ((message as Record<string, unknown>).role !== "assistant") continue;
    return assistantErrorSummary(message);
  }
  return undefined;
}
