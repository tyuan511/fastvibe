type Entry = { id: string; type: string; message?: unknown };
type Window = { start: number; end: number; beforeEntryId: string | null; found: boolean };
const TOOL_CALLS = new Set(["tool_use", "toolcall", "tool_call", "toolCall"]);

/** Same visible-user boundary as mapEngineMessages, without copying image data. */
function visibleUser(message: Record<string, unknown>): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  let texts = 0;
  for (const part of content) {
    if (typeof part === "string") { if (part || ++texts > 1) return true; continue; }
    if (!record(part)) continue;
    if (part.type === "thinking") {
      const thought = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
      if (thought) return true;
      continue;
    }
    if (typeof part.text === "string" && (part.text || ++texts > 1)) return true;
    if (TOOL_CALLS.has(String(part.type)) || (part.type === "image" && typeof part.data === "string")) return true;
  }
  return false;
}

const indexes = new WeakMap<readonly Entry[], { boundaries: number[]; byId: Map<string, number> }>();

function indexTurns(entries: readonly Entry[]) {
  const cached = indexes.get(entries);
  if (cached) return cached;
  const results = new Map<string, number>();
  for (let index = 0; index < entries.length; index++) {
    const message = entries[index].message;
    if (record(message) && message.role === "toolResult") {
      const id = String(message.toolCallId ?? "");
      if (id) results.set(id, index);
    }
  }
  const boundaries: number[] = [];
  const byId = new Map<string, number>();
  let through = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const message = entry.message;
    if (entry.type !== "message" || !record(message)) continue;
    if (index > through && visibleUser(message)) {
      boundaries.push(index);
      byId.set(entry.id, index);
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (record(part) && TOOL_CALLS.has(String(part.type))) {
          through = Math.max(through, results.get(String(part.id ?? "")) ?? -1);
        }
      }
    }
  }
  const result = { boundaries, byId };
  indexes.set(entries, result);
  return result;
}

/** Boundaries are complete user turns. Never split a tool call from a later result,
 * even when a steering prompt was inserted between them. Limits are deliberately soft. */
export function transcriptWindow(entries: readonly Entry[], requested = 12, beforeEntryId?: string): Window {
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.floor(requested))) : 12;
  const { boundaries, byId } = indexTurns(entries);
  const end = beforeEntryId ? byId.get(beforeEntryId) ?? -1 : entries.length;
  if (end < 0) return { start: 0, end: 0, beforeEntryId: null, found: false };
  const count = boundaryAtOrAfter(boundaries, end);
  // The first turn includes any preceding notices/settings, avoiding an empty extra page.
  const start = count > limit ? boundaries[count - limit] : 0;
  return { start, end, beforeEntryId: start > 0 ? entries[start].id : null, found: true };
}

/** Enough of this entry's complete turn to attach every result to its tool call. */
export function transcriptEntryEnd(entries: readonly Entry[], start: number): number {
  const { boundaries } = indexTurns(entries);
  return boundaries[boundaryAtOrAfter(boundaries, start + 1)] ?? entries.length;
}

function boundaryAtOrAfter(boundaries: number[], end: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (boundaries[middle] < end) low = middle + 1;
    else high = middle;
  }
  return low;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
