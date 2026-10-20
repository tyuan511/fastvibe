import type { ChatMessage, MessagePart, ToolCallBlock } from "@shared/types";
import { i18n } from "@/lib/i18n";
import { collapseToolRuns, runSummary, type RunFoldOptions, type RunItem, type ThinkingPart, type SummaryPiece } from "./tool-run";

/**
 * Consecutive quiet tools between two stretches of prose collapse into one row.
 * The fold rule itself lives in `tool-run.ts`.
 */

export type ToolGroup = {
  id: string;
  /** Settled line, e.g. 「已思考 2 次，已运行 2 个命令，已读取 process-manager.ts」. */
  summary: string;
  pieces: SummaryPiece[];
  /** Everything the row stands for, in the order the engine wrote it: calls and thoughts. */
  items: RunItem[];
  tools: ToolCallBlock[];
  /** How many thoughts this row hides — 0 unless 折叠思考内容 is on. */
  thoughts: number;
  running: boolean;
  /**
   * The thought being written right now, when the row is live on reasoning rather than on
   * a call. `running` is then true as well, and the row shimmers 「正在思考」 with the same
   * growing preview an unfolded thinking block shows.
   */
  liveThinking?: ThinkingPart;
};

export type RenderPart =
  | { kind: "text"; text: string }
  | Extract<MessagePart, { kind: "thinking" }>
  | Extract<MessagePart, { kind: "model" }>
  | Extract<MessagePart, { kind: "compact" }>
  | { kind: "tool"; tool: ToolCallBlock }
  | { kind: "group"; group: ToolGroup };

/**
 * The engine emits one assistant message per LLM round-trip, so a reply that calls
 * tools arrives as several messages. They are a single visual turn: merge them so
 * the transcript shows one block with one copy/retry footer instead of a footer per
 * round-trip.
 *
 * Cached on the last message's identity: `applyEngineEvent` clones only the message
 * being streamed into, so a finished row keeps the same final message object and can
 * be served from here instead of re-merged (and re-diffed) on every token.
 */
const mergedRuns = new WeakMap<ChatMessage, ChatMessage>();

export function mergeAssistantRun(messages: ChatMessage[]): ChatMessage {
  const first = messages[0];
  if (messages.length === 1) return first;

  // A compaction divider is its own row. If one is still in this list, it is not an
  // assistant round-trip — time the footer from the last assistant, not from the divider.
  let lastAssistant: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      lastAssistant = messages[index];
      break;
    }
  }
  const key = lastAssistant ?? messages[messages.length - 1];
  const cached = mergedRuns.get(key);
  if (cached) return cached;

  const tools = new Map<string, ToolCallBlock>();
  const parts: MessagePart[] = [];
  const texts: string[] = [];
  const thoughts: string[] = [];

  for (const message of messages) {
    for (const tool of message.tools) tools.set(tool.id, tool);
    for (const part of resolveParts(message)) {
      // A round-trip can end mid-prose and the next continue it; keep that one
      // paragraph rather than rendering two bubbles with a gap.
      const previous = parts.at(-1);
      if (part.kind === "text" && previous?.kind === "text") {
        parts[parts.length - 1] = { kind: "text", text: `${previous.text}${part.text}` };
        continue;
      }
      parts.push(part);
    }
    if (message.role === "assistant") {
      if (message.text) texts.push(message.text);
      if (message.thinking) thoughts.push(message.thinking);
    }
  }

  // Same rule as `completedAt`: the row's status is its last round-trip, never a
  // search back. Auto-retry (and a model switch that continues the same visual
  // turn) leaves the failed attempt in the transcript, then appends the reply
  // that actually ran. Walking back for `error` pasted that 429 under thinking /
  // todos that were already writing.
  const last = lastAssistant ?? messages[messages.length - 1];
  const error = last?.error;
  // Auto-retry is also a status of the last round-trip. Keep it when the row merges
  // several assistant messages; otherwise a retry after a tool call silently loses
  // its banner even though the reducer put it on the trailing message.
  const retry = last?.retry;
  // A truncation or stop notice belongs to the round-trip that ended the row, for the
  // same reason: an earlier attempt a 继续 resumed from must not keep its notice.
  const stop = last?.stop;
  // The row ends when its final round-trip does. Deliberately not a search back
  // through the run: an open round-trip has no end yet, and borrowing the previous
  // one's would report a stale finish time the moment it is read mid-stream.
  const completedAt = last?.completedAt;
  // Where the run that produced this row's last round-trips began. A failed or stopped
  // round-trip followed by another one means the user came back (继续, a retry on another
  // model) — the failure and the wait before it are not that run's work. Reading it off the
  // transcript is what keeps the clock right after a reload, which the live stamp cannot.
  let runStartedAt = first.runStartedAt;
  for (let index = 0; index < messages.length - 1; index += 1) {
    const item = messages[index];
    if (item.role !== "assistant" || (item.error === undefined && item.stop === undefined)) continue;
    const next = messages.slice(index + 1).find((candidate) => candidate.role === "assistant");
    if (next) runStartedAt = next.createdAt;
  }
  const merged: ChatMessage = {
    ...first,
    runStartedAt,
    text: texts.join("\n\n"),
    thinking: thoughts.length > 0 ? thoughts.join("\n\n") : undefined,
    tools: [...tools.values()],
    parts,
    error,
    retry,
    stop,
    completedAt,
  };
  mergedRuns.set(key, merged);
  return merged;
}

export type MessageRow = {
  id: string;
  messages: ChatMessage[];
};

/**
 * Consecutive assistant messages collapse into one row; user and system messages
 * always stand alone, so the transcript still alternates prompt → reply.
 */
/**
 * A compact part glued onto the reply it followed still has to render as its own
 * divider. Older snapshots and a live card that landed inside the assistant row
 * would otherwise show 「正在压缩上下文」 under that turn's footer.
 */
function splitCompacts(message: ChatMessage): ChatMessage[] {
  if (message.kind === "compact" || message.role !== "assistant" || !message.parts?.some((part) => part.kind === "compact")) {
    return [message];
  }
  const bodyParts = message.parts.filter((part) => part.kind !== "compact");
  const body: ChatMessage = { ...message, parts: bodyParts };
  const hasBody =
    Boolean(body.text || body.thinking || body.error) ||
    body.tools.length > 0 ||
    bodyParts.length > 0;
  const notices: ChatMessage[] = [];
  let index = 0;
  for (const part of message.parts) {
    if (part.kind !== "compact") continue;
    notices.push({
      id: index === 0 ? `${message.id}:compact` : `${message.id}:compact:${index}`,
      role: "system",
      text: part.text,
      tools: [],
      parts: [part],
      createdAt: message.createdAt,
      kind: "compact",
      compact: part.compact,
    });
    index += 1;
  }
  return hasBody ? [body, ...notices] : notices;
}

export function groupMessageRows(messages: ChatMessage[]): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const source of messages) {
    for (const message of splitCompacts(source)) {
      const last = rows.at(-1);
      // A compaction is a divider between turns, not part of the reply it followed.
      // Folding it into that row is what put 「正在压缩上下文」 inside the previous turn.
      if (message.role === "assistant" && last && last.messages[0].role === "assistant") {
        last.messages.push(message);
        continue;
      }
      rows.push({ id: message.id, messages: [message] });
    }
  }
  return rows;
}

/**
 * Messages persisted before `parts` existed (or user rows, which have only text)
 * fall back to the flat fields so nothing renders blank.
 */
export function resolveParts(message: ChatMessage): MessagePart[] {
  if (message.kind === "compact") {
    return [{ kind: "compact", text: message.text, compact: message.compact }];
  }
  if (message.parts && message.parts.length > 0) return message.parts;
  const parts: MessagePart[] = [];
  if (message.thinking) parts.push({ kind: "thinking", text: message.thinking });
  if (message.text) parts.push({ kind: "text", text: message.text });
  for (const tool of message.tools) parts.push({ kind: "tool", toolId: tool.id });
  return parts;
}

/**
 * A settled run of quiet tools keeps the same group object while a reply streams on.
 *
 * `mergeAssistantRun` and `groupParts` are rebuilt for the streaming row on every flush, and
 * building a group walks its items to write the summary line. A turn with hundreds of calls
 * therefore re-summarised every one of them per token and handed `ToolGroupRow` a new object
 * each time, which defeated its memo. Tool blocks keep their identity once they are done
 * (`applyEngineEvent` clones only the one being written), so a group is reused while it still
 * holds the very same blocks in the same order, under the same fold.
 */
const builtGroups = new WeakMap<ToolCallBlock, { key: string; id: string; items: RunItem[]; tools: ToolCallBlock[]; group: ToolGroup }>();

function sameTools(a: readonly ToolCallBlock[], b: readonly ToolCallBlock[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Identity, not text: a streamed thinking part is cloned on every delta, so a batch whose
 * thought is still growing always misses this cache — which is what keeps the live preview
 * current. Once the parts settle their identity holds, and the row stops rebuilding.
 */
function sameItems(a: readonly RunItem[], b: readonly RunItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === "tool" && right.kind === "tool" && left.tool !== right.tool) return false;
    if (left.kind === "thinking" && right.kind === "thinking" && (left.part !== right.part || left.live !== right.live)) return false;
  }
  return true;
}

function buildGroup(
  run: { id: string; items: RunItem[]; tools: ToolCallBlock[]; liveThinking?: ThinkingPart },
  language: string,
  fold: boolean,
): ToolGroup {
  const first = run.tools[0];
  const key = `${language}${fold ? "f" : "-"}`;
  const cached = first ? builtGroups.get(first) : undefined;
  if (cached && cached.key === key && cached.id === run.id && sameTools(cached.tools, run.tools) && sameItems(cached.items, run.items)) {
    return cached.group;
  }
  const summary = runSummary(run.items, (k, options) => i18n.t(k, options) as string);
  const thoughts = run.items.reduce((total, item) => total + (item.kind === "thinking" ? 1 : 0), 0);
  const group: ToolGroup = {
    id: run.id,
    summary: summary.line,
    pieces: summary.pieces,
    items: run.items,
    tools: run.tools,
    thoughts,
    running: run.liveThinking !== undefined || run.tools.some((tool) => tool.status === "running"),
    liveThinking: run.liveThinking,
  };
  if (first) builtGroups.set(first, { key, id: run.id, items: run.items, tools: run.tools, group });
  return group;
}

/**
 * Cached on the message identity, the active language and how the run is folded — the summary
 * is translated, so a language switch must not serve the previous line, and a preference
 * change (or a run settling) must not keep serving the old fold.
 */
const groupedParts = new WeakMap<ChatMessage, { key: string; parts: RenderPart[] }>();

/** Resolve tool ids, and fold consecutive quiet calls that sit between prose. */
export function groupParts(message: ChatMessage, language: string = i18n.language, fold: RunFoldOptions = {}): RenderPart[] {
  const key = `${language}|${fold.collapseThinking ? 1 : 0}|${fold.streaming ? 1 : 0}`;
  const cached = groupedParts.get(message);
  if (cached && cached.key === key) return cached.parts;

  const byId = new Map(message.tools.map((tool) => [tool.id, tool]));
  const parts: RenderPart[] = collapseToolRuns(resolveParts(message), byId, fold).map((part) =>
    part.kind === "run" ? { kind: "group", group: buildGroup(part, language, fold.collapseThinking === true) } : part,
  );
  groupedParts.set(message, { key, parts });
  return parts;
}
