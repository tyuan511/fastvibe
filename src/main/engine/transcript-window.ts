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

/** Boundaries are complete user turns. Never split a tool call from a later result,
 * even when a steering prompt was inserted between them. Limits are deliberately soft. */
export function transcriptWindow(entries: readonly Entry[], requested = 12, beforeEntryId?: string): Window {
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.floor(requested))) : 12;
  const results = new Map<string, number>();
  for (let index = 0; index < entries.length; index++) {
    const message = entries[index].message;
    if (record(message) && message.role === "toolResult") {
      const id = String(message.toolCallId ?? "");
      if (id) results.set(id, index);
    }
  }
  const boundaries: number[] = [];
  let through = -1;
  let end = beforeEntryId ? -1 : entries.length;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const message = entry.message;
    if (entry.type !== "message" || !record(message)) continue;
    if (index > through && visibleUser(message)) {
      boundaries.push(index);
      if (entry.id === beforeEntryId) end = index;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (record(part) && TOOL_CALLS.has(String(part.type))) {
          through = Math.max(through, results.get(String(part.id ?? "")) ?? -1);
        }
      }
    }
  }
  if (end < 0) return { start: 0, end: 0, beforeEntryId: null, found: false };
  const earlier = boundaries.filter((index) => index < end);
  // The first turn includes any preceding notices/settings, avoiding an empty extra page.
  const start = earlier.length > limit ? earlier[earlier.length - limit] : 0;
  return { start, end, beforeEntryId: start > 0 ? entries[start].id : null, found: true };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
