import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FileEditIcon, FolderSearchIcon, SquareTerminalIcon } from "@hugeicons/core-free-icons";
import type { ChatMessage, MessagePart, ToolCallBlock } from "@shared/types";
import { i18n } from "@/lib/i18n";
import { asRecord, familyOf, type ToolFamily } from "./tool-presentation";

/**
 * Consecutive runs of related tools collapse into one summary row, the way zcode
 * folds exploration / edits / commands. A single tool stays on its own line; only
 * ≥2 adjacent siblings become a group, so a lone `read` is never hidden behind a
 * summary.
 */

export type ToolGroupKind = "explore" | "changes" | "terminal";

export type ToolGroup = {
  id: string;
  kind: ToolGroupKind;
  label: string;
  icon: ReactNode;
  /** One-line sentence, e.g. 「3 个搜索, 2 个列表, 5 个文件」. */
  summary: string;
  /** Diff totals for change groups. */
  stat?: { added: number; removed: number };
  tools: ToolCallBlock[];
  running: boolean;
  failed: number;
};

export type RenderPart =
  | { kind: "text"; text: string }
  | Extract<MessagePart, { kind: "thinking" }>
  | Extract<MessagePart, { kind: "model" }>
  | { kind: "tool"; tool: ToolCallBlock }
  | { kind: "group"; group: ToolGroup };

const GROUP_MEMBERS: Record<ToolGroupKind, ToolFamily[]> = {
  explore: ["read", "search", "list"],
  changes: ["edit", "write", "delete"],
  terminal: ["terminal"],
};

const GROUP_STYLE: Record<ToolGroupKind, { icon: ReactNode }> = {
  explore: { icon: <HugeiconsIcon strokeWidth={2} icon={FolderSearchIcon} className="size-3.5" /> },
  changes: { icon: <HugeiconsIcon strokeWidth={2} icon={FileEditIcon} className="size-3.5" /> },
  terminal: { icon: <HugeiconsIcon strokeWidth={2} icon={SquareTerminalIcon} className="size-3.5" /> },
};

/** Category name for a group header; translated when the group is built. */
function groupKindLabel(kind: ToolGroupKind): string {
  return i18n.t(`common:group.${kind}`) as string;
}

function groupKindOf(tool: ToolCallBlock): ToolGroupKind | null {
  const family = familyOf(tool.name);
  for (const kind of ["changes", "terminal", "explore"] as ToolGroupKind[]) {
    if (GROUP_MEMBERS[kind].includes(family)) return kind;
  }
  return null;
}

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

  const key = messages[messages.length - 1];
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
    if (message.text) texts.push(message.text);
    if (message.thinking) thoughts.push(message.thinking);
  }

  // Same rule as `completedAt`: the row's status is its last round-trip, never a
  // search back. Auto-retry (and a model switch that continues the same visual
  // turn) leaves the failed attempt in the transcript, then appends the reply
  // that actually ran. Walking back for `error` pasted that 429 under thinking /
  // todos that were already writing.
  const last = messages[messages.length - 1];
  const error = last?.error;
  // A truncation or stop notice belongs to the round-trip that ended the row, for the
  // same reason: an earlier attempt a 继续 resumed from must not keep its notice.
  const stop = last?.stop;
  // The row ends when its final round-trip does. Deliberately not a search back
  // through the run: an open round-trip has no end yet, and borrowing the previous
  // one's would report a stale finish time the moment it is read mid-stream.
  const completedAt = last?.completedAt;
  const merged: ChatMessage = {
    ...first,
    text: texts.join("\n\n"),
    thinking: thoughts.length > 0 ? thoughts.join("\n\n") : undefined,
    tools: [...tools.values()],
    parts,
    error,
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
export function groupMessageRows(messages: ChatMessage[]): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const message of messages) {
    const last = rows.at(-1);
    if (message.role === "assistant" && last && last.messages[0].role === "assistant") {
      last.messages.push(message);
      continue;
    }
    rows.push({ id: message.id, messages: [message] });
  }
  return rows;
}

/**
 * Messages persisted before `parts` existed (or user rows, which have only text)
 * fall back to the flat fields so nothing renders blank.
 */
export function resolveParts(message: ChatMessage): MessagePart[] {
  if (message.parts && message.parts.length > 0) return message.parts;
  const parts: MessagePart[] = [];
  if (message.thinking) parts.push({ kind: "thinking", text: message.thinking });
  if (message.text) parts.push({ kind: "text", text: message.text });
  for (const tool of message.tools) parts.push({ kind: "tool", toolId: tool.id });
  return parts;
}

function diffStat(text: string | undefined): { added: number; removed: number } {
  if (!text) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** The engine hands structured diffs to `edit` results; prefer them over guessing. */
function toolDiff(tool: ToolCallBlock): string | undefined {
  const details = asRecord(tool.details);
  if (typeof details?.diff === "string") return details.diff;
  return undefined;
}

function exploreSummary(tools: ToolCallBlock[]): string {
  const families = tools.map((tool) => familyOf(tool.name));
  const search = families.filter((family) => family === "search").length;
  const list = families.filter((family) => family === "list").length;
  const file = families.filter((family) => family === "read").length;
  const bits: string[] = [];
  if (search > 0) bits.push(i18n.t("common:group.searches", { count: search }) as string);
  if (list > 0) bits.push(i18n.t("common:group.lists", { count: list }) as string);
  if (file > 0) bits.push(i18n.t("common:group.files", { count: file }) as string);
  return bits.join(", ") || (i18n.t("common:group.operations", { count: tools.length }) as string);
}

function changeStat(tools: ToolCallBlock[]): { added: number; removed: number } {
  return tools.reduce(
    (total, tool) => {
      if (tool.status === "error") return total;
      const stat = diffStat(toolDiff(tool) ?? tool.result);
      return { added: total.added + stat.added, removed: total.removed + stat.removed };
    },
    { added: 0, removed: 0 },
  );
}

function buildGroup(kind: ToolGroupKind, tools: ToolCallBlock[]): ToolGroup {
  const style = GROUP_STYLE[kind];
  const failed = tools.filter((tool) => tool.status === "error").length;
  const group: ToolGroup = {
    id: `group:${kind}:${tools[0]?.id ?? "0"}`,
    kind,
    label: groupKindLabel(kind),
    icon: style.icon,
    summary: "",
    tools,
    running: tools.some((tool) => tool.status === "running"),
    failed,
  };

  if (kind === "explore") {
    group.summary = exploreSummary(tools);
  } else if (kind === "changes") {
    const stat = changeStat(tools);
    group.summary = i18n.t("common:group.files", { count: tools.length }) as string;
    if (stat.added > 0 || stat.removed > 0) group.stat = stat;
  } else {
    const commands = i18n.t("common:group.commands", { count: tools.length }) as string;
    group.summary = failed > 0 ? `${commands}, ${i18n.t("common:group.failed", { count: failed })}` : commands;
  }
  return group;
}

/**
 * Walk the message in order and fold adjacent tools of the same group kind.
 * Anything that is not a tool (prose, thinking) breaks the run, which keeps the
 * narrative sequence the engine produced. Cached on the merged message's identity
 * *and* the active language — the labels inside are translated, so a language switch
 * must not serve the previous language's summaries back. Callers pass no language:
 * it is read fresh here, and (because the value is part of the cache key) reading it
 * per render is what invalidates the cache.
 */
const groupedParts = new WeakMap<ChatMessage, { language: string; parts: RenderPart[] }>();

export function groupParts(message: ChatMessage, language: string = i18n.language): RenderPart[] {
  const cached = groupedParts.get(message);
  if (cached && cached.language === language) return cached.parts;

  const byId = new Map(message.tools.map((tool) => [tool.id, tool]));
  const output: RenderPart[] = [];
  let pendingKind: ToolGroupKind | null = null;
  let pending: ToolCallBlock[] = [];

  const flush = (): void => {
    if (pending.length === 1) output.push({ kind: "tool", tool: pending[0] });
    else if (pending.length > 1 && pendingKind) output.push({ kind: "group", group: buildGroup(pendingKind, pending) });
    pending = [];
    pendingKind = null;
  };

  for (const part of resolveParts(message)) {
    if (part.kind !== "tool") {
      flush();
      output.push(part);
      continue;
    }
    const tool = byId.get(part.toolId);
    if (!tool) continue;
    const kind = groupKindOf(tool);
    if (kind && kind === pendingKind) {
      pending.push(tool);
      continue;
    }
    flush();
    if (kind) {
      pendingKind = kind;
      pending = [tool];
    } else {
      output.push({ kind: "tool", tool });
    }
  }
  flush();
  groupedParts.set(message, { language, parts: output });
  return output;
}
