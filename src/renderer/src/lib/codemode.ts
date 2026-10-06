/**
 * What the transcript shows of a `codemode` call: the script, and the tool calls the script
 * made. Pure, so the card and the tests read the same rules.
 *
 * The SDK's `codemode` tool takes one argument, `code`, which is JavaScript source and not
 * JSON; its result text starts "Script completed" / "Script failed". The calls the script made
 * arrive in the result's `details.calls`, which is also what a streaming update carries.
 */

export type CodemodeCallStatus = "running" | "ok" | "error" | "cancelled";

export type CodemodeCall = {
  id: string;
  name: string;
  /** Compact JSON of the arguments, already truncated by the engine. */
  args: string;
  status: CodemodeCallStatus;
  durationMs?: number;
  error?: string;
};

/** The first line of a script is allowed to be `// @options: {…}`: settings, not code. */
const OPTIONS_LINE = /^\s*\/\/\s*@options\s*:/;

export function codemodeCode(args: unknown): string {
  if (typeof args !== "object" || args === null) return typeof args === "string" ? args : "";
  const code = (args as Record<string, unknown>).code;
  return typeof code === "string" ? code : "";
}

/** The script without its options line, and the options on their own. */
export function splitCodemodeSource(code: string): { options?: string; body: string } {
  const [first = "", ...rest] = code.split("\n");
  if (!OPTIONS_LINE.test(first)) return { body: code };
  return { options: first.replace(OPTIONS_LINE, "").trim(), body: rest.join("\n").replace(/^\n+/, "") };
}

/**
 * One line that says what the script is for: its first line of code, or failing that its
 * first comment. A leading comment is usually the model saying what it is about to do.
 */
export function codemodeSummary(code: string, limit = 120): string {
  const { body } = splitCodemodeSource(code);
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const comment = lines.find((line) => line.startsWith("//"));
  const line = comment ? comment.replace(/^\/\/+\s*/, "") : (lines[0] ?? "");
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

const STATUSES = new Set<string>(["running", "ok", "error", "cancelled"]);

/** The calls a script made so far, from a result's or an update's `details`. */
export function codemodeCalls(details: unknown): CodemodeCall[] {
  if (typeof details !== "object" || details === null) return [];
  const list = (details as Record<string, unknown>).calls;
  if (!Array.isArray(list)) return [];
  const calls: CodemodeCall[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    calls.push({
      id: record.id,
      name: record.name,
      args: typeof record.args === "string" ? record.args : "",
      status: typeof record.status === "string" && STATUSES.has(record.status) ? (record.status as CodemodeCallStatus) : "running",
      ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
      ...(typeof record.error === "string" && record.error ? { error: record.error } : {}),
    });
  }
  return calls;
}

/** How many of the calls failed or were cut short. */
export function codemodeFailures(calls: readonly CodemodeCall[]): number {
  return calls.filter((call) => call.status === "error" || call.status === "cancelled").length;
}

/**
 * The script as a fenced code block that cannot be closed from inside: a fence longer than
 * the longest run of backticks in the code, so a template literal in a script does not end it.
 */
export function codemodeFence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}js\n${code}\n${fence}`;
}

/** A duration for a row: 「120 ms」 below a second, 「1.4 s」 above. */
export function formatCallDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
