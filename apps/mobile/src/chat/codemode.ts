/**
 * What the phone shows of a `codemode` call, and how a live tool event is read.
 *
 * The desktop has the same rules (`src/renderer/src/lib/codemode.ts`); the phone app is its own
 * package and imports nothing from the desktop tree, so the few functions it needs live here.
 *
 * `codemode` takes one argument, `code` — JavaScript, not JSON. The tools the script ran arrive in
 * the result's `details.calls`, and each streaming update carries the same list, in the update's
 * `partialResult.details` rather than on the event itself.
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

const OPTIONS_LINE = /^\s*\/\/\s*@options\s*:/;
const STATUSES = new Set<string>(["running", "ok", "error", "cancelled"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function codemodeCode(args: unknown): string {
  if (typeof args === "string") return args;
  const code = asRecord(args)?.code;
  return typeof code === "string" ? code : "";
}

/** The script without its `// @options:` line, which is settings and not code. */
export function codemodeBody(code: string): string {
  const [first = "", ...rest] = code.split("\n");
  return OPTIONS_LINE.test(first) ? rest.join("\n").replace(/^\n+/, "") : code;
}

/** One line saying what the script is for: the model's leading comment, else its first line of code. */
export function codemodeSummary(code: string, limit = 100): string {
  const lines = codemodeBody(code).split("\n").map((line) => line.trim()).filter(Boolean);
  const comment = lines.find((line) => line.startsWith("//"));
  const line = comment ? comment.replace(/^\/\/+\s*/, "") : (lines[0] ?? "");
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** The calls a script made so far, from a result's or an update's `details`. */
export function codemodeCalls(details: unknown): CodemodeCall[] {
  const list = asRecord(details)?.calls;
  if (!Array.isArray(list)) return [];
  const calls: CodemodeCall[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record || typeof record.id !== "string" || typeof record.name !== "string") continue;
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

/** A duration for a row: 「120 ms」 below a second, 「1.5 s」 above. */
export function formatCallDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/* ---- reading a live tool event -------------------------------------------------------- */

/**
 * The id of the call that made this one, when a tool ran it itself (`ctx.executeTool()` — a
 * `codemode` script's calls). Such an event is not a row of the transcript: the script's own card
 * lists its calls, and a row per call would turn one script into a column of them.
 */
export function nestedParent(event: Record<string, unknown>): string | undefined {
  return typeof event.parentToolCallId === "string" && event.parentToolCallId ? event.parentToolCallId : undefined;
}

/** A tool event's structured payload: on the event itself, or inside its partial / final result. */
export function toolEventDetails(event: Record<string, unknown>): unknown {
  if (event.details !== undefined) return event.details;
  return asRecord(event.partialResult)?.details ?? asRecord(event.result)?.details;
}

/**
 * A tool result as text. The engine's result is `{ content: [{ type: "text", text }], details }`;
 * the text parts are what a reader wants, not that object's JSON.
 */
export function toolResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  const content = asRecord(value)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "string" ? part : asRecord(part)?.type === "text" && typeof asRecord(part)?.text === "string" ? (asRecord(part)?.text as string) : ""))
      .filter(Boolean)
      .join("\n");
    // An update that only reports progress in `details` has no text yet: nothing to show.
    return text || undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
