/** Pi exposes execution failures through results, rather than Codex's ToolCallOutcome. */
export function executionUnavailable(event: { toolName: string; isError: boolean; durationMs?: number; result: unknown }): boolean {
  if (!event.isError || !["bash", "powershell"].includes(event.toolName) || event.durationMs === undefined) return false;
  const result = event.result as { structuredContent?: { exit_code?: unknown }; content?: Array<{ type: string; text?: string }> } | undefined;
  // A command that ran and returned a nonzero exit code is not a broken execution backend.
  if (typeof result?.structuredContent?.exit_code === "number") return false;
  const text = result?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
  // Pi has no typed handler-failure reason. Match launch/setup errors conservatively;
  // cancellations, command timeouts, validation and policy refusals are not evidence.
  return /(?:spawn(?:sync)?\s[^\n]*\b(?:ENOENT|EACCES|EPERM)\b|working directory does not exist:|custom shell path not found:|no bash shell found|no powershell executable found|cannot find (?:bash|powershell|shell)|(?:shell|execution backend) (?:is )?(?:unavailable|not found))/i.test(text);
}

/** Monotonic active-goal time; reloads restore only persisted elapsed time, never offline time. */
export class GoalClock {
  #milliseconds = 0;
  #at: number | undefined;
  readonly #now: () => number;
  constructor(now: () => number = () => performance.now()) { this.#now = now; }
  reset(seconds = 0): void { this.#milliseconds = seconds * 1000; this.#at = undefined; }
  sample(active: boolean): number {
    const now = this.#now();
    if (this.#at !== undefined) this.#milliseconds += Math.max(0, now - this.#at);
    this.#at = active ? now : undefined;
    return Math.floor(this.#milliseconds / 1000);
  }
}
