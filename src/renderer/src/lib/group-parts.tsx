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
const compactNoticeCache = new WeakMap<object, ChatMessage>();
const singleRowCache = new WeakMap<ChatMessage, MessageRow>();

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
    const cached = compactNoticeCache.get(part);
    const notice = cached ?? {
      id: index === 0 ? `${message.id}:compact` : `${message.id}:compact:${index}`,
      role: "system" as const,
      text: part.text,
      tools: [],
      parts: [part],
      createdAt: message.createdAt,
      kind: "compact" as const,
      compact: part.compact,
    };
    if (!cached) compactNoticeCache.set(part, notice);
    notices.push(notice);
    index += 1;
  }
  return hasBody ? [body, ...notices] : notices;
}

const splitCompactCache = new WeakMap<ChatMessage, ChatMessage[]>;

function splitCompactsCached(message: ChatMessage): ChatMessage[] {
  const cached = splitCompactCache.get(message);
  if (cached) return cached;
  const split = splitCompacts(message);
  splitCompactCache.set(message, split);
  return split;
}

/**
 * The row's source range in the transcript. A row can span several consecutive
 * assistant messages, while a compact message can produce more than one row.
 */
type RowSpan = { start: number; end: number };
type TurnSpan = { start: number; end: number };

export type Turn = { id: string; rows: MessageRow[] };

/**
 * The complete chat projection used by MessageList. `source` is kept so the next
 * flush can find the first changed message by identity; everything before that
 * point is the settled prefix and is reused by reference.
 */
export type MessageRowsProjection = {
  source: readonly ChatMessage[];
  rows: MessageRow[];
  rowSpans: RowSpan[];
  turns: Turn[];
  turnSpans: TurnSpan[];
  rowIndex: Map<string, number>;
  rowIndexByMessage: Map<string, number>;
};

function commonPrefix<T>(left: readonly T[], right: readonly T[]): number {
  const count = Math.min(left.length, right.length);
  let index = 0;
  while (index < count && left[index] === right[index]) index += 1;
  return index;
}

function buildRowsFrom(
  messages: readonly ChatMessage[],
  start: number,
  rows: MessageRow[],
  spans: RowSpan[],
): void {
  for (let sourceIndex = start; sourceIndex < messages.length; sourceIndex += 1) {
    for (const message of splitCompactsCached(messages[sourceIndex])) {
      const last = rows.at(-1);
      const lastSpan = spans.at(-1);
      if (message.role === "assistant" && last && last.messages[0].role === "assistant" && lastSpan) {
        // The previous row may belong to the settled prefix. Clone only its
        // tail-facing shell before adding a streamed assistant message.
        rows[rows.length - 1] = { id: last.id, messages: [...last.messages, message] };
        spans[spans.length - 1] = { start: lastSpan.start, end: sourceIndex + 1 };
      } else {
        const cached = singleRowCache.get(message);
        const row = cached ?? { id: message.id, messages: [message] };
        if (!cached) singleRowCache.set(message, row);
        rows.push(row);
        spans.push({ start: sourceIndex, end: sourceIndex + 1 });
      }
    }
  }
}

function buildTurnsFrom(
  rows: readonly MessageRow[],
  start: number,
  turns: Turn[],
  spans: TurnSpan[],
): void {
  for (let rowIndex = start; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const current = turns.at(-1);
    const currentSpan = spans.at(-1);
    if (row.messages[0].role !== "user" && current && currentSpan) {
      // As with rows, a changed streaming row must not mutate a settled turn.
      turns[turns.length - 1] = { id: current.id, rows: [...current.rows, row] };
      spans[spans.length - 1] = { start: currentSpan.start, end: rowIndex + 1 };
    } else {
      turns.push({ id: row.id, rows: [row] });
      spans.push({ start: rowIndex, end: rowIndex + 1 });
    }
  }
}

function rowIndexFor(rows: readonly MessageRow[]): Map<string, number> {
  return new Map(rows.map((row, index) => [row.id, index]));
}

function rowIndexByMessageFor(turns: readonly Turn[]): Map<string, number> {
  const index = new Map<string, number>();
  turns.forEach((turn, turnIndex) => {
    for (const row of turn.rows) {
      index.set(row.id, turnIndex);
      for (const message of row.messages) index.set(message.id, turnIndex);
    }
  });
  return index;
}

function sameRowIndexStructure(left: readonly MessageRow[], right: readonly MessageRow[], start: number): boolean {
  if (left.length !== right.length) return false;
  for (let index = start; index < right.length; index += 1) {
    if (left[index]?.id !== right[index]?.id) return false;
  }
  return true;
}

function sameTurnIndexStructure(left: readonly Turn[], right: readonly Turn[], start: number): boolean {
  if (left.length !== right.length) return false;
  for (let turnIndex = start; turnIndex < right.length; turnIndex += 1) {
    const oldTurn = left[turnIndex];
    const nextTurn = right[turnIndex];
    if (!oldTurn || !nextTurn || oldTurn.id !== nextTurn.id || oldTurn.rows.length !== nextTurn.rows.length) return false;
    for (let rowIndex = 0; rowIndex < nextTurn.rows.length; rowIndex += 1) {
      const oldRow = oldTurn.rows[rowIndex];
      const nextRow = nextTurn.rows[rowIndex];
      if (!oldRow || oldRow.id !== nextRow.id || oldRow.messages[0]?.role !== nextRow.messages[0]?.role) return false;
      if (oldRow.messages.length !== nextRow.messages.length) return false;
      for (let messageIndex = 0; messageIndex < nextRow.messages.length; messageIndex += 1) {
        if (oldRow.messages[messageIndex]?.id !== nextRow.messages[messageIndex]?.id) return false;
      }
    }
  }
  return true;
}

function incrementalRowIndex(
  previous: MessageRowsProjection,
  rows: readonly MessageRow[],
  changedRow: number,
): Map<string, number> {
  if (sameRowIndexStructure(previous.rows, rows, changedRow)) return previous.rowIndex;
  const index = new Map(previous.rowIndex);
  for (let rowIndex = changedRow; rowIndex < previous.rows.length; rowIndex += 1) index.delete(previous.rows[rowIndex]!.id);
  for (let rowIndex = changedRow; rowIndex < rows.length; rowIndex += 1) index.set(rows[rowIndex]!.id, rowIndex);
  return index;
}

function deleteTurnKeys(index: Map<string, number>, turn: Turn): void {
  for (const row of turn.rows) {
    index.delete(row.id);
    for (const message of row.messages) index.delete(message.id);
  }
}

function addTurnKeys(index: Map<string, number>, turn: Turn, turnIndex: number): void {
  for (const row of turn.rows) {
    index.set(row.id, turnIndex);
    for (const message of row.messages) index.set(message.id, turnIndex);
  }
}

function incrementalMessageIndex(
  previous: MessageRowsProjection,
  turns: readonly Turn[],
  firstTurn: number,
): Map<string, number> {
  if (sameTurnIndexStructure(previous.turns, turns, firstTurn)) return previous.rowIndexByMessage;
  const index = new Map(previous.rowIndexByMessage);
  for (let turnIndex = firstTurn; turnIndex < previous.turns.length; turnIndex += 1) deleteTurnKeys(index, previous.turns[turnIndex]!);
  for (let turnIndex = firstTurn; turnIndex < turns.length; turnIndex += 1) addTurnKeys(index, turns[turnIndex]!, turnIndex);
  return index;
}


/**
 * Group and index a transcript with settled-prefix + streaming-tail reuse.
 *
 * A live event clones only the assistant message it writes into. We use that
 * identity boundary to retain every complete row/turn before the changed tail,
 * then rebuild from the first affected row. Full replacement or a mid-transcript
 * edit still falls back to the same canonical grouping rules, so this is safe for
 * reloads as well as streams.
 */
export function groupMessageRowsIncremental(
  messages: ChatMessage[],
  previous?: MessageRowsProjection,
): MessageRowsProjection {
  if (previous?.source === messages) return previous;

  const changedSource = previous ? commonPrefix(previous.source, messages) : 0;
  let firstRow = 0;
  if (previous) {
    while (firstRow < previous.rowSpans.length && previous.rowSpans[firstRow]!.end <= changedSource) firstRow += 1;
  }
  const rows = previous ? previous.rows.slice(0, firstRow) : [];
  const rowSpans = previous ? previous.rowSpans.slice(0, firstRow) : [];
  const startSource = rowSpans.at(-1)?.end ?? 0;
  buildRowsFrom(messages, startSource, rows, rowSpans);

  const changedRow = previous ? commonPrefix(previous.rows, rows) : 0;
  let firstTurn = 0;
  if (previous) {
    while (firstTurn < previous.turnSpans.length && previous.turnSpans[firstTurn]!.end <= changedRow) firstTurn += 1;
  }
  const turns = previous ? previous.turns.slice(0, firstTurn) : [];
  const turnSpans = previous ? previous.turnSpans.slice(0, firstTurn) : [];
  const startRow = turnSpans.at(-1)?.end ?? 0;
  buildTurnsFrom(rows, startRow, turns, turnSpans);

  const rowIndex = previous ? incrementalRowIndex(previous, rows, changedRow) : rowIndexFor(rows);
  const rowIndexByMessage = previous ? incrementalMessageIndex(previous, turns, firstTurn) : rowIndexByMessageFor(turns);
  return { source: messages, rows, rowSpans, turns, turnSpans, rowIndex, rowIndexByMessage };
}

export function groupMessageRows(messages: ChatMessage[]): MessageRow[] {
  return groupMessageRowsIncremental(messages).rows;
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
    if (left.kind === "thinking" && right.kind === "thinking" && left.part !== right.part) return false;
  }
  return true;
}

function buildGroup(
  run: { id: string; items: RunItem[]; tools: ToolCallBlock[] },
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
