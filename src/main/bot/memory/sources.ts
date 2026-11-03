import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripPromptMetadata } from "../../../shared/attachment-metadata.ts";
import type { BotConversationMeta, BotInput, BotMemoryRef, BotResult } from "../../../shared/bot.ts";
import { redactSecrets, renderRollout } from "../../engine/memory-transcript.ts";
import type { ViviMemorySource } from "./types.ts";

/** Small descriptors only: tool evidence is loaded lazily for the selected source. */
export function viviMemorySources(data: {
  conversations: readonly BotConversationMeta[];
  inputs: readonly BotInput[];
  results: readonly BotResult[];
}): ViviMemorySource[] {
  const conversations = new Map(data.conversations.map((item) => [item.conversationId, item]));
  const inputs = new Map(data.inputs.map((item) => [item.id, item]));
  const sources: ViviMemorySource[] = [];
  for (const input of data.inputs) {
    const meta = conversations.get(input.conversationId);
    if (!meta || input.intent === "status" || !["completed", "failed"].includes(input.status) || !["user", "answer"].includes(input.source)) continue;
    const text = redactSecrets(stripPromptMetadata(input.text).trim());
    if (!text) continue;
    sources.push({ id: `input:${input.id}`, conversationId: meta.conversationId, requestId: input.id, epoch: input.epoch, createdAt: input.createdAt, role: meta.role, kind: "input", text, title: meta.title, outcome: input.status });
  }
  for (const result of data.results) {
    const meta = conversations.get(result.conversationId);
    const input = result.inputId ? inputs.get(result.inputId) : undefined;
    if (meta?.role !== "worker" || !input || input.conversationId !== result.conversationId || input.epoch !== result.epoch || !["completed", "failed"].includes(input.status) || !["ready", "failed", "blocked"].includes(result.status)) continue;
    sources.push({ id: `result:${result.id}`, conversationId: meta.conversationId, requestId: input.id, epoch: input.epoch, createdAt: (input.rootInputId ? inputs.get(input.rootInputId)?.createdAt : undefined) ?? input.createdAt, role: "worker", kind: "result", title: meta.title, outcome: result.status, text: redactSecrets(`Request:\n${stripPromptMetadata(input.text)}\n\nReported outcome (verify against tool evidence):\n${result.summary ?? ""}`), evidence: result.evidence?.map(redactSecrets) });
  }
  return sources.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Before/after anchors delimit one real input, never text-matching another turn. */
export function viviMemoryMaterial(input: BotInput, branch: readonly SessionEntry[]): string {
  const span = input.memoryBranch;
  if (!span?.afterEntryId) return "No persisted execution evidence was captured for this input. Do not infer successful verification.";
  const end = branch.findIndex((entry) => entry.id === span.afterEntryId);
  const start = span.beforeEntryId ? branch.findIndex((entry) => entry.id === span.beforeEntryId) : -1;
  if (end < 0 || (span.beforeEntryId && start < 0) || start >= end) return "The recorded execution branch is no longer available. Revalidate any technical conclusion.";
  const internal = /^bot_/;
  const entries = branch.slice(start + 1, end + 1).flatMap((entry): SessionEntry[] => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role === "user") return []; // Already supplied as cleaned source text.
    if (message.role === "toolResult" && internal.test(message.toolName)) return [];
    if (message.role === "assistant") return [{ ...entry, message: { ...message, content: message.content.filter((block) => block.type !== "toolCall" || !internal.test(block.name)) } }];
    return [entry];
  });
  return renderRollout(entries, 24_000).text || "No actual tool verification was recorded in this input.";
}

/** Transport inputs may name only small Markdown references in Vivi's own folder. */
export function botMemoryRefs(value: unknown): BotMemoryRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) throw new Error("At most three Vivi memory references are allowed.");
  return value.map((ref) => {
    if (!ref || typeof ref !== "object" || typeof ref.path !== "string" || !/^(?:MEMORY\.md|memory_summary\.md|rollout_summaries\/[A-Za-z0-9_.-]+\.md)$/.test(ref.path) || ref.path.includes("..")) throw new Error("Invalid Vivi memory reference.");
    if (ref.heading !== undefined && (typeof ref.heading !== "string" || !ref.heading.trim() || ref.heading.length > 160)) throw new Error("Invalid Vivi memory heading.");
    for (const key of ["offset", "limit"] as const) if (ref[key] !== undefined && (!Number.isInteger(ref[key]) || ref[key] < 1 || ref[key] > (key === "limit" ? 120 : 100_000))) throw new Error("Invalid Vivi memory range.");
    return { path: ref.path, ...(ref.heading !== undefined ? { heading: ref.heading } : {}), ...(ref.offset !== undefined ? { offset: ref.offset } : {}), ...(ref.limit !== undefined ? { limit: ref.limit } : {}) };
  });
}
