import type { ChatMessage, ToolCallBlock } from "@shared/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTodoTool(name: string): boolean {
  return name.trim().toLowerCase().includes("todo");
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  /** Present-continuous label shown while the item is in_progress. */
  activeForm?: string;
};

export type CompactTodos = {
  compact: boolean;
  preceding: TodoItem[];
  focus: TodoItem[];
  following: TodoItem[];
};

const FOCUS = 3;
const COMPACT_LIMIT = 6;

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeStatus(value: unknown, done?: unknown): TodoStatus {
  if (done === true) return "completed";
  const key = asText(value).toLowerCase().replace(/[-\s]/g, "_");
  if (key === "completed" || key === "complete" || key === "done") return "completed";
  if (key === "in_progress" || key === "inprogress" || key === "doing" || key === "running" || key === "active") {
    return "in_progress";
  }
  if (key === "cancelled" || key === "canceled") return "cancelled";
  return "pending";
}

function fromUnknown(value: unknown, index: number): TodoItem | null {
  if (typeof value === "string") {
    const content = value.trim();
    return content ? { id: String(index), content, status: "pending" } : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const content = asText(record.content) || asText(record.title) || asText(record.text) || asText(record.task);
  if (!content) return null;
  const activeForm = asText(record.activeForm) || asText(record.active_form);
  return {
    id: asText(record.id) || String(index),
    content,
    status: normalizeStatus(record.status, record.done ?? record.completed),
    ...(activeForm ? { activeForm } : {}),
  };
}

/** Pull a todo list out of whatever shape the tool args / details / result used. */
export function parseTodoList(value: unknown): TodoItem[] {
  if (Array.isArray(value)) {
    return value.map(fromUnknown).filter((item): item is TodoItem => item !== null);
  }
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["todos", "tasks", "items", "list"]) {
    if (Array.isArray(record[key])) return parseTodoList(record[key]);
  }
  return [];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseToolTodos(tool: ToolCallBlock): TodoItem[] {
  const fromArgs = parseTodoList(tool.args);
  if (fromArgs.length > 0) return fromArgs;
  const fromDetails = parseTodoList(asRecord(tool.details)?.todos ?? tool.details);
  if (fromDetails.length > 0) return fromDetails;
  if (tool.result) {
    const parsed = parseJson(tool.result);
    const fromResult = parseTodoList(parsed);
    if (fromResult.length > 0) return fromResult;
  }
  return [];
}

const EMPTY_TODOS: TodoItem[] = [];

/** Latest todo list in the transcript — the agent's current plan. */
export function latestTodos(messages: ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tools = messages[i]?.tools ?? [];
    for (let j = tools.length - 1; j >= 0; j--) {
      const tool = tools[j];
      if (!isTodoTool(tool.name)) continue;
      const todos = parseToolTodos(tool);
      if (todos.length > 0) return todos;
    }
  }
  return EMPTY_TODOS;
}

/**
 * zcode's status-panel folding: ≤6 items stay open; longer lists keep 3
 * around the in-progress (or first unfinished) item and tuck the rest.
 */
export function compactTodos(items: TodoItem[]): CompactTodos {
  if (items.length <= COMPACT_LIMIT) {
    return { compact: false, preceding: [], focus: items, following: [] };
  }
  const inProgress = items.findIndex((item) => item.status === "in_progress");
  const firstOpen = items.findIndex((item) => item.status !== "completed" && item.status !== "cancelled");
  const anchor = inProgress >= 0 ? inProgress : firstOpen >= 0 ? firstOpen : Math.max(0, items.length - FOCUS);
  const start = Math.max(0, Math.min(anchor, items.length - FOCUS));
  const end = Math.min(items.length, start + FOCUS);
  return {
    compact: true,
    preceding: items.slice(0, start),
    focus: items.slice(start, end),
    following: items.slice(end),
  };
}
