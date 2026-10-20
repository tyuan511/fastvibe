import type { MessagePart, ToolCallBlock } from "@shared/types";
import { familyOf, type ToolFamily } from "./tool-family.ts";
import { thinkingTakesRow } from "./thinking-row.ts";
import { blankTakesRow } from "./blank-output.ts";

/** A reasoning block, with the bounds Main measured for it when there are any. */
export type ThinkingPart = Extract<MessagePart, { kind: "thinking" }>;

/**
 * Consecutive tool calls between two stretches of prose fold into one row.
 *
 * By default a thought is not part of that row: it is its own block, and it splits the
 * batch the same way prose does. Otherwise a thought between two calls disappears into
 * the fold, and the reader cannot see that the model stopped to think.
 *
 * 设置 → 对话 → 折叠思考内容 (`collapseThinking`) changes that: a thought then joins the
 * batch it sits in and the settled line counts it (「已思考 2 次」). It only ever joins a
 * batch that has a call in it — the option folds thinking *into the tool summary*, and a
 * thought with no call around it has no summary to be folded into, so it keeps its own row.
 *
 * A few calls stay on their own line and break the run, because the row is the
 * thing to see: a question waits on the reader, and a todo / sub-agent / presented
 * file / task graph is its own card. Reads and writes stay in the
 * batch — the summary names them, it does not hide them behind 「已运行」.
 */
const STANDALONE_FAMILIES = new Set<ToolFamily>(["question", "todo", "agent", "present"]);

export function foldsIntoRun(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key || key.startsWith("dag_")) return false;
  return !STANDALONE_FAMILIES.has(familyOf(key));
}

export type RunItem =
  | { kind: "tool"; tool: ToolCallBlock }
  /** `live` is set only on the thought still being written at the reply's tail. */
  | { kind: "thinking"; part: ThinkingPart; live: boolean };

export type ToolRun = {
  /** First call's id, so a later call in the same batch does not remount the row. */
  id: string;
  items: RunItem[];
  tools: ToolCallBlock[];
  /**
   * The thought this row is currently writing, when it is live on a thought rather than on
   * a call. The row then shimmers 「正在思考」 exactly as an unfolded block does, instead of
   * the call description it would otherwise print while the batch is in flight.
   */
  liveThinking?: ThinkingPart;
};

export type RunFoldOptions = {
  /** Fold thoughts into the run they sit in (the preference behind it). */
  collapseThinking?: boolean;
  /** This reply is still streaming, which is what makes its last thought a live one. */
  streaming?: boolean;
};

export type CollapsedPart =
  | Exclude<MessagePart, { kind: "tool" }>
  | { kind: "tool"; tool: ToolCallBlock }
  | ({ kind: "run" } & ToolRun);

/**
 * Fold adjacent quiet tools (and, with `collapseThinking`, the thoughts between them)
 * into one run. A single call stays a row — it already is its own description. Without
 * the preference, thinking is emitted on its own and splits the batch, the same as prose.
 */
export function collapseToolRuns(
  parts: MessagePart[],
  toolById: ReadonlyMap<string, ToolCallBlock>,
  options: RunFoldOptions = {},
): CollapsedPart[] {
  const foldThoughts = options.collapseThinking === true;
  const output: CollapsedPart[] = [];
  let pending: RunItem[] = [];

  const flush = (): void => {
    const tools = pending.flatMap((item) => (item.kind === "tool" ? [item.tool] : []));
    const thoughts = pending.length - tools.length;
    if (tools.length === 0) {
      // Thoughts only: no call to fold them into, so each keeps its own block.
      for (const item of pending) if (item.kind === "thinking") output.push(item.part);
    } else if (tools.length >= 2 || thoughts > 0) {
      const last = pending[pending.length - 1];
      output.push({
        kind: "run",
        id: `run:${tools[0].id}`,
        items: pending,
        tools,
        liveThinking: last?.kind === "thinking" && last.live ? last.part : undefined,
      });
    } else if (tools[0]) {
      output.push({ kind: "tool", tool: tools[0] });
    }
    pending = [];
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    // A part may only break the batch if the reader can actually see it. 空的思考不占一行 and
    // 模型输出的空白不占一整屏 both hide a part that is nothing but whitespace, and such a part
    // splitting the run is the bug this guard ends: a provider really does finish a reasoning
    // block whose whole text is one space (seen in the wild between two shell calls), and the
    // transcript then read 「已运行 6 个命令」 plus 「已运行 2 个命令」 with *nothing* between them.
    const live = options.streaming === true && index === parts.length - 1;
    if (part.kind === "thinking" && !thinkingTakesRow(part.text, live)) continue;
    if (part.kind === "text" && !blankTakesRow(part.text, live)) continue;
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
    if (foldThoughts && part.kind === "thinking") {
      pending.push({ kind: "thinking", part, live });
      continue;
    }
    // Thinking, prose, and every other part sit outside the fold and split it.
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

/**
 * A named file carries `path` so the summary can draw it as a path link. A query or a
 * tool name is only a label — previewing it would open nothing.
 */
export type SummaryPiece = { kind: "text"; text: string } | { kind: "file"; name: string; path?: string };

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

const FILE_FAMILIES = new Set<ToolFamily>(["read", "write", "edit", "delete"]);

/** The name a settled clause prints, plus the path when that name is a file. */
function namedPiece(tool: ToolCallBlock): SummaryPiece {
  const name = callName(tool);
  if (!FILE_FAMILIES.has(familyOf(tool.name))) return { kind: "file", name };
  const path = argString(tool.args, FILE_KEYS);
  return path ? { kind: "file", name, path } : { kind: "file", name };
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
 * The categories a settled line reports. Everything that folds falls into one of them, so
 * the line is at most six clauses however many calls a batch made. Reads and writes stay
 * apart; searches and the rest of the tool surface each gather into one, and so do the
 * thoughts the option folded in.
 */
type RunCategory = "think" | "command" | "read" | "write" | "search" | "tool";

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
  // A thought has nothing to name — no file, no query — so it is always counted.
  think: { one: "common:group.thoughts", many: "common:group.thoughts" },
  command: { one: "common:group.ranCommands", many: "common:group.ranCommands" },
  read: { one: "common:group.readOne", many: "common:group.readMany" },
  write: { one: "common:group.writeOne", many: "common:group.writeMany" },
  search: { one: "common:group.searchOne", many: "common:group.searchMany" },
  tool: { one: "common:group.toolOne", many: "common:group.toolMany" },
};

/** Commands and thoughts are only ever counted; neither has a name to print. */
const COUNT_ONLY = new Set<RunCategory>(["command", "think"]);

/** A later clause of the same sentence: drop a leading 「已」, or uncapitalise an English verb. */
function continueClause(clause: string): string {
  if (clause.startsWith("已")) return clause.slice(1);
  return clause.replace(/^[A-Z]/, (letter) => letter.toLowerCase());
}

/**
 * Settled line. Each category appears once, in the order it first showed up: one call names
 * the file or query, several say how many. A failed call is not counted here — the expanded
 * row already marks it.
 */
export function runSummary(items: RunItem[], text: Translate): { line: string; pieces: SummaryPiece[] } {
  const buckets = new Map<RunCategory, RunItem[]>();
  const order: RunCategory[] = [];
  for (const item of items) {
    const category = item.kind === "thinking" ? "think" : CATEGORY_OF[familyOf(item.tool.name)];
    const bucket = buckets.get(category);
    if (bucket) bucket.push(item);
    else {
      buckets.set(category, [item]);
      order.push(category);
    }
  }

  const pieces: SummaryPiece[] = [];
  const separator = text("common:group.separator");
  // 「已」covers the whole line. Later clauses drop it, and an English verb drops
  // its capital, so the line reads as one sentence rather than a list of them.
  const push = (clause: SummaryPiece[]): void => {
    const first = pieces.length === 0;
    if (!first) pieces.push({ kind: "text", text: separator });
    const [head, ...rest] = clause;
    if (head?.kind === "text" && !first) pieces.push({ kind: "text", text: continueClause(head.text) }, ...rest);
    else pieces.push(...clause);
  };

  for (const category of order) {
    const batch = buckets.get(category) ?? [];
    if (batch.length === 0) continue;
    const clause = CATEGORY_CLAUSE[category];
    const single = batch.length === 1 && batch[0]?.kind === "tool" ? batch[0].tool : undefined;
    if (single && !COUNT_ONLY.has(category)) {
      push([{ kind: "text", text: `${text(clause.one)} ` }, namedPiece(single)]);
      continue;
    }
    push([{ kind: "text", text: text(clause.many, { count: batch.length }) }]);
  }

  return { line: pieces.map((piece) => (piece.kind === "file" ? piece.name : piece.text)).join(""), pieces };
}
