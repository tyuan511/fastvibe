import type { AgentThread } from "../../../shared/agent-thread.ts";
import type { ChatMessage } from "../../../shared/types.ts";
import { REVIEW_COMMAND_TYPE } from "../../../shared/review.ts";

const rows = new WeakMap<AgentThread, ChatMessage>();
const commandRows = new WeakMap<AgentThread, ChatMessage>();

/** Merge a snapshot and live pushes by revision, scoped to one transcript owner. */
export function mergeReviewThreads(current: readonly AgentThread[], incoming: readonly AgentThread[], conversationId: string): readonly AgentThread[] {
  const owned = current.filter((thread) => thread.conversationId === conversationId && thread.review);
  const byId = new Map(owned.map((thread) => [thread.id, thread]));
  let changed = owned.length !== current.length;
  for (const thread of incoming) {
    if (thread.conversationId !== conversationId || !thread.review) continue;
    const previous = byId.get(thread.id);
    if (!previous || previous.revision < thread.revision) { byId.set(thread.id, thread); changed = true; }
  }
  return changed ? [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) : current;
}

function reviewRow(thread: AgentThread): ChatMessage {
  const previous = rows.get(thread);
  if (previous) return previous;
  const message: ChatMessage = {
    id: `review-card:${thread.conversationId}:${thread.id}`,
    role: "system", kind: "custom", customType: "fastvibe-review-card",
    text: thread.reviewReport?.summary ?? "", tools: [], parts: [],
    // A changing status/report must not move a card to a later user request.
    createdAt: thread.createdAt, review: thread,
  };
  rows.set(thread, message);
  return message;
}

/**
 * The `/review` line that started a command review, as its own row above the card.
 *
 * The command never becomes a prompt, so the SDK transcript has no user message for it;
 * the row is derived from the durable thread exactly like the card. A review started from
 * the dialog or the Git pane has no command and therefore no row.
 */
function commandRow(thread: AgentThread): ChatMessage {
  const previous = commandRows.get(thread);
  if (previous) return previous;
  const message: ChatMessage = {
    id: `review-command:${thread.conversationId}:${thread.id}`,
    role: "system", kind: "custom", customType: REVIEW_COMMAND_TYPE,
    text: thread.review!.command!, tools: [], parts: [],
    // Just before the card it opened, never after it.
    createdAt: thread.createdAt - 1,
  };
  commandRows.set(thread, message);
  return message;
}

/** UI-only rows derived from durable Review threads. Never write fabricated SDK messages. */
export function projectReviewMessages(messages: ChatMessage[], threads: readonly AgentThread[], conversationId?: string | null): ChatMessage[] {
  if (!conversationId) return messages;
  const cards = new Map<string, ChatMessage>();
  for (const thread of threads) {
    if (thread.conversationId !== conversationId || !thread.review) continue;
    const previous = cards.get(thread.id);
    if (!previous || previous.review!.revision < thread.revision) {
      cards.set(thread.id, reviewRow(thread));
      if (thread.review.command) cards.set(`${thread.id}:command`, commandRow(thread));
    }
  }
  if (!cards.size) return messages;
  const pending = [...cards.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const ids = new Set(pending.map((item) => item.id));
  const output: ChatMessage[] = [];
  let next = 0;
  for (const message of messages) {
    if (ids.has(message.id)) continue;
    while (next < pending.length && pending[next].createdAt <= message.createdAt) output.push(pending[next++]);
    output.push(message);
  }
  while (next < pending.length) output.push(pending[next++]);
  return output;
}
