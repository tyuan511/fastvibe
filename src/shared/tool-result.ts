import type { ToolCallStatus } from "./types";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

/**
 * A stopped delegated run is still an error result for the parent model: that is how
 * it learns the delegation did not finish. In the transcript, though, it is an
 * intentional cancellation rather than a failure and must not be drawn as a red
 * tool error.
 *
 * Use the structured result details instead of matching text such as "aborted" — a
 * real provider or tool failure is allowed to contain that word.
 */
export function toolResultStatus(
  toolName: string | undefined,
  isError: boolean,
  details: unknown,
): ToolCallStatus {
  if (!isError) return "done";
  if (toolName?.toLowerCase() !== "subagent") return "error";

  const results = asRecord(details)?.results;
  if (
    Array.isArray(results) &&
    results.some((result) => asRecord(result)?.stopReason === "aborted")
  ) {
    return "aborted";
  }
  return "error";
}
