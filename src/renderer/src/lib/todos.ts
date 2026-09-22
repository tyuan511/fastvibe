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

/** The item the agent is on: what is `in_progress`, else the next `pending` one. */
export function activeTodo(items: TodoItem[]): TodoItem | undefined {
  return items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");
}

/**
 * 1-based position of the item in play, for the `n/N` every todo surface shows.
 * The leading number names *which* step the agent is on, not how many it has
 * ticked off: `1/N` from the first moment rather than sitting at `0/N` (and, on
 * a plan worked back-to-front, understating progress) until that step closes.
 */
export function todoPosition(items: TodoItem[]): number {
  const active = activeTodo(items);
  return active ? items.indexOf(active) + 1 : items.length;
}

/** 1-based position of a known item, falling back to the end of the list. */
export function todoIndexOf(items: TodoItem[], item: TodoItem | undefined): number {
  const index = item ? items.indexOf(item) : -1;
  return index >= 0 ? index + 1 : items.length;
}

const EMPTY_TODOS: TodoItem[] = [];

/** Index of the newest user turn in the transcript, or -1 when there is none. */
function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function scanTodos(messages: ChatMessage[]): { items: TodoItem[]; messageIndex: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tools = messages[i]?.tools ?? [];
    for (let j = tools.length - 1; j >= 0; j--) {
      const tool = tools[j];
      if (!isTodoTool(tool.name) || tool.status === "running") continue;
      const todos = parseToolTodos(tool);
      if (todos.length > 0) return { items: todos, messageIndex: i };
    }
  }
  return { items: EMPTY_TODOS, messageIndex: -1 };
}

/**
 * The list the panel would draw, plus whether the newest user prompt arrived after
 * it was written.
 *
 * Do not read a running call here. Tool arguments arrive incrementally while the
 * model is streaming, so using them would make the panel above the composer
 * repaint for every partial JSON update. The tool card may still show that live
 * call, but the persistent panel only advances after execution has produced its
 * final result (or an error).
 *
 * A list is written for the request being worked on, and it stays in the transcript
 * as history. But the composer slot above the input is the scarcest space in the app,
 * and a checklist from an earlier turn is not this turn's plan: ask something else and
 * it would sit there while an unrelated run streams, claiming work that is not
 * happening. So a newer user prompt closes the panel; it comes back only when the
 * agent writes the list again (`todo` at the start of the new turn), which is also the
 * signal that the work is back on a checklist. A list written during the current turn
 * — including the reply still streaming — is not superseded.
 */
export function todoSnapshot(messages: ChatMessage[]): { items: TodoItem[]; superseded: boolean } {
  const { items, messageIndex } = scanTodos(messages);
  if (items.length === 0 || messageIndex < 0) return { items, superseded: false };
  return { items, superseded: lastUserIndex(messages) > messageIndex };
}
