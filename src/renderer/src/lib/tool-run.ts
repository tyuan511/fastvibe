import type { MessagePart, ToolCallBlock } from "@shared/types";
import { familyOf, type ToolFamily } from "./tool-family.ts";

/**
 * Consecutive tool calls between two stretches of prose fold into one row.
 * A thought between two calls is not narration — the model thinks, then calls —
 * so thinking must not split the run, or a real turn never folds. Prose does:
 * that is the sentence the reader is meant to see between batches.
 *
 * A few calls stay on their own line and break the run, because the row is the
 * thing to see: a question waits on the reader, and a todo / sub-agent / presented
 * file / decision task / task graph is its own card. Reads and writes stay in the
 * batch — the summary names them, it does not hide them behind 「已运行」.
 */
const STANDALONE_FAMILIES = new Set<ToolFamily>(["question", "todo", "agent", "present"]);

export function foldsIntoRun(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key || key.startsWith("dag_")) return false;
  if (key === "browser_task" || key === "computer_task") return false;
  return !STANDALONE_FAMILIES.has(familyOf(key));
}

export type RunItem =
  | { kind: "thinking"; part: Extract<MessagePart, { kind: "thinking" }> }
  | { kind: "tool"; tool: ToolCallBlock };

export type ToolRun = {
  /** First call's id, so a later call in the same batch does not remount the row. */
  id: string;
  items: RunItem[];
  tools: ToolCallBlock[];
};

export type CollapsedPart =
  | Exclude<MessagePart, { kind: "tool" }>
  | { kind: "tool"; tool: ToolCallBlock }
  | ({ kind: "run" } & ToolRun);

/**
 * Fold adjacent quiet tools into one run. A single call stays a row — it already
 * is its own description. Thinking that only separates the calls, including the
 * thought after the last call and before the next sentence, stays inside the run
 * so the collapsed line sits directly between the two stretches of prose.
 */
export function collapseToolRuns(
  parts: MessagePart[],
  toolById: ReadonlyMap<string, ToolCallBlock>,
): CollapsedPart[] {
  const output: CollapsedPart[] = [];
  let pending: RunItem[] = [];

  const emitLoose = (item: RunItem): void => {
    output.push(item.kind === "thinking" ? item.part : { kind: "tool", tool: item.tool });
  };

  const flush = (): void => {
    const tools = pending.flatMap((item) => (item.kind === "tool" ? [item.tool] : []));
    if (tools.length >= 2) {
      output.push({ kind: "run", id: `run:${tools[0].id}`, items: pending, tools });
    } else {
      for (const item of pending) emitLoose(item);
    }
    pending = [];
  };

  for (const part of parts) {
    if (part.kind === "thinking") {
      pending.push({ kind: "thinking", part });
      continue;
    }
    if (part.kind === "tool") {
      const tool = toolById.get(part.toolId);
      if (!tool) continue;
      if (foldsIntoRun(tool.name)) {
        pending.push({ kind: "tool", tool });
        continue;
      }
      flush();
      output.push({ kind: "tool", tool });
      continue;
    }
    flush();
    output.push(part);
  }
  flush();
  return output;
}

/** The call actually in flight, not merely the last one listed. */
export function liveTool(tools: ToolCallBlock[]): ToolCallBlock | undefined {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index]?.status === "running") return tools[index];
  }
  return undefined;
}

type Translate = (key: string, options?: { count?: number }) => string;

export type SummaryPiece = { kind: "text"; text: string } | { kind: "file"; name: string };

const FILE_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "target"];
const QUERY_KEYS = ["query", "pattern", "search_query", "searchQuery", "regex"];

function argString(args: unknown, keys: string[]): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function baseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

/** What a single non-command call is named by. A file call uses the file name. */
export function callName(tool: ToolCallBlock): string {
  const family = familyOf(tool.name);
  if (family === "read" || family === "write" || family === "edit" || family === "delete") {
    const path = argString(tool.args, FILE_KEYS);
    return path ? baseName(path) : tool.name;
  }
  if (family === "search" || family === "web") return argString(tool.args, QUERY_KEYS) || tool.name;
  if (family === "list") {
    const path = argString(tool.args, ["path", "dir", "directory", "pattern"]);
    return path ? baseName(path) : ".";
  }
  return tool.name;
}

/**
 * The five categories a settled line reports. Everything that folds falls into
 * one of them, so the line is at most five clauses however many calls a batch
 * made. Reads and writes stay apart; searches and the rest of the tool surface
 * each gather into one.
 */
type RunCategory = "command" | "read" | "write" | "search" | "tool";

const CATEGORY_OF: Record<ToolFamily, RunCategory> = {
  terminal: "command",
  read: "read",
  write: "write",
  edit: "write",
  delete: "write",
  search: "search",
  web: "search",
  list: "search",
  skill: "tool",
  agent: "tool",
  todo: "tool",
  question: "tool",
  mcp: "tool",
  codemode: "tool",
  browser: "tool",
  present: "tool",
  other: "tool",
};

const CATEGORY_CLAUSE: Record<RunCategory, { one: string; many: string }> = {
  command: { one: "common:group.ranCommands", many: "common:group.ranCommands" },
  read: { one: "common:group.readOne", many: "common:group.readMany" },
  write: { one: "common:group.writeOne", many: "common:group.writeMany" },
  search: { one: "common:group.searchOne", many: "common:group.searchMany" },
  tool: { one: "common:group.toolOne", many: "common:group.toolMany" },
};

/** Commands are only ever counted; a single shell call is not named by its command. */
const COUNT_ONLY = new Set<RunCategory>(["command"]);

/**
 * Settled line. Each category appears once, in the order it first showed up:
 * one call names the file or query, several say how many. Failures sit at the end.
 */
export function runSummary(tools: ToolCallBlock[], text: Translate): { line: string; pieces: SummaryPiece[] } {
  const buckets = new Map<RunCategory, ToolCallBlock[]>();
  const order: RunCategory[] = [];
  for (const tool of tools) {
    const category = CATEGORY_OF[familyOf(tool.name)];
    const bucket = buckets.get(category);
    if (bucket) bucket.push(tool);
    else {
      buckets.set(category, [tool]);
      order.push(category);
    }
  }

  const pieces: SummaryPiece[] = [];
  const separator = text("common:group.separator");
  const push = (clause: SummaryPiece[]): void => {
    if (pieces.length > 0) pieces.push({ kind: "text", text: separator });
    pieces.push(...clause);
  };

  for (const category of order) {
    const batch = buckets.get(category) ?? [];
    if (batch.length === 0) continue;
    const clause = CATEGORY_CLAUSE[category];
    if (batch.length === 1 && !COUNT_ONLY.has(category)) {
      push([
        { kind: "text", text: `${text(clause.one)} ` },
        { kind: "file", name: callName(batch[0]) },
      ]);
      continue;
    }
    push([{ kind: "text", text: text(clause.many, { count: batch.length }) }]);
  }

  const failed = tools.filter((tool) => tool.status === "error").length;
  if (failed > 0) pieces.push({ kind: "text", text: ` (${text("common:group.failed", { count: failed })})` });
  return { line: pieces.map((piece) => (piece.kind === "file" ? piece.name : piece.text)).join(""), pieces };
}
