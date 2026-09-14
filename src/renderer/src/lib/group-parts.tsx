import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FileCodeIcon, FolderSearchIcon, SquareTerminalIcon } from "@hugeicons/core-free-icons";
import type { ChatMessage, MessagePart, ToolCallBlock } from "@shared/types";
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
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: ToolCallBlock }
  | { kind: "group"; group: ToolGroup };

const GROUP_MEMBERS: Record<ToolGroupKind, ToolFamily[]> = {
  explore: ["read", "search", "list"],
  changes: ["edit", "write", "delete"],
  terminal: ["terminal"],
};

const GROUP_STYLE: Record<ToolGroupKind, { label: string; icon: ReactNode }> = {
  explore: { label: "查阅", icon: <HugeiconsIcon strokeWidth={2} icon={FolderSearchIcon} className="size-3.5" /> },
  changes: { label: "更改", icon: <HugeiconsIcon strokeWidth={2} icon={FileCodeIcon} className="size-3.5" /> },
  terminal: { label: "终端", icon: <HugeiconsIcon strokeWidth={2} icon={SquareTerminalIcon} className="size-3.5" /> },
};

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
 */
export function mergeAssistantRun(messages: ChatMessage[]): ChatMessage {
  const first = messages[0];
  if (messages.length === 1) return first;

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

  return {
    ...first,
    text: texts.join("\n\n"),
    thinking: thoughts.length > 0 ? thoughts.join("\n\n") : undefined,
    tools: [...tools.values()],
    parts,
  };
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
  if (search > 0) bits.push(`${search} 个搜索`);
  if (list > 0) bits.push(`${list} 个列表`);
  if (file > 0) bits.push(`${file} 个文件`);
  return bits.join(", ") || `${tools.length} 个操作`;
}

function changeStat(tools: ToolCallBlock[]): { added: number; removed: number } {
  return tools.reduce(
    (total, tool) => {
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
    label: style.label,
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
    group.summary = `${tools.length} 个文件`;
    if (stat.added > 0 || stat.removed > 0) group.stat = stat;
  } else {
    const commands = `${tools.length} 个命令`;
    group.summary = failed > 0 ? `${commands}, ${failed} 个失败` : commands;
  }
  return group;
}

/**
 * Walk the message in order and fold adjacent tools of the same group kind.
 * Anything that is not a tool (prose, thinking) breaks the run, which keeps the
 * narrative sequence the engine produced.
 */
export function groupParts(message: ChatMessage): RenderPart[] {
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
  return output;
}
