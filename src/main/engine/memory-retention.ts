import type { MemoryItem } from "../../shared/memory.ts";

export const MEMORY_DAY_MS = 86_400_000;
export const MEMORY_MAINTENANCE_BATCH = 500;

/** Protection is conservative: uncertain classification must not erase a standing rule.
 * Default-mode type scores are guesses, so explicit durable wording is also protected.
 * This detector only preserves content; it never establishes that a fact is obsolete. */
export function retainedMemory(item: Pick<MemoryItem, "pinned" | "role" | "kind" | "typeScores" | "content">): boolean {
  return Boolean(item.pinned || item.role === "summary"
    || item.kind === "preference" || item.kind === "procedural"
    || (item.typeScores?.preference ?? 0) >= 0.6
    || (item.typeScores?.procedural ?? 0) >= 0.6
    || /偏好|习惯|约定|始终|永远|以后都|今后都|记住|默认使用|必须|不要|\b(?:prefer(?:ence|ences|s)?|always|never|remember|from now on|must)\b/iu.test(item.content));
}

export function sameMemoryScope(a: Pick<MemoryItem, "project" | "conversationId">, b: Pick<MemoryItem, "project" | "conversationId">): boolean {
  return a.project ? a.project === b.project : !b.project && a.conversationId === b.conversationId;
}
