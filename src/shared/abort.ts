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
