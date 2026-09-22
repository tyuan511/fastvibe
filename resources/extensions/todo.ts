import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/**
 * FastVibe's built-in todo list — Claude Code's TodoWrite, as a pi tool.
 *
 * The model replaces the entire list on every call (`pending` / `in_progress` /
 * `completed` / `cancelled`). State lives in tool-result `details`, so branching
 * reconstructs the list from that point in history. The renderer already treats
 * a tool named `todo` as a checklist card; unfinished items also surface above
 * the composer (`TodoPanel`).
 */
const TOOL = "todo";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

type Todo = {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
};

type TodoDetails = { todos: Todo[] };

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

const DESCRIPTION = [
  "Create and manage a structured task list for this session.",
  "Replace the entire list on every call — do not add or toggle items one by one.",
  "",
  "Use this tool when:",
  "- The work has 3 or more distinct steps, or is non-trivial and needs a plan",
  "- The user lists multiple tasks, or explicitly asks for a todo list",
  "- New instructions arrive — capture them as todos immediately",
  "- You start a task — mark it in_progress BEFORE beginning work",
  "- You finish a task — mark it completed immediately and add anything you discovered",
  "",
  "Skip this tool when:",
  "- There is only a single, straightforward task",
  "- The work is trivial (fewer than 3 steps) or the user is asking a question",
  "",
  "States: pending (not started), in_progress (currently working), completed (fully done), cancelled (no longer needed).",
  "Exactly one item may be in_progress at a time. Mark completed only after the work is actually finished — not when tests fail, the implementation is incomplete, or errors remain.",
  "content is the imperative task (\"Run tests\"); activeForm is the present-continuous form shown while it is in_progress (\"Running tests\").",
].join("\n");

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asStatus(value: unknown): TodoStatus {
  const key = asText(value).toLowerCase().replace(/[-\s]/g, "_");
  if (key === "completed" || key === "complete" || key === "done") return "completed";
  if (key === "in_progress" || key === "inprogress" || key === "doing" || key === "running" || key === "active") {
    return "in_progress";
  }
  if (key === "cancelled" || key === "canceled") return "cancelled";
  return "pending";
}

function mark(status: TodoStatus): string {
  if (status === "completed") return "x";
  if (status === "in_progress") return ">";
  if (status === "cancelled") return "-";
  return " ";
}

function formatList(todos: Todo[]): string {
  const done = todos.filter((item) => item.status === "completed").length;
  const lines = todos.map((item) => `- [${mark(item.status)}] ${item.content}`);
  return `Todos updated (${done}/${todos.length})\n${lines.join("\n")}`;
}

function normalize(raw: unknown[]): Todo[] {
  const todos: Todo[] = [];
  let inProgress = false;
  for (const [index, value] of raw.entries()) {
    if (typeof value === "string") {
      const content = value.trim();
      if (!content) continue;
      todos.push({ id: String(index + 1), content, status: "pending" });
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const content = asText(record.content) || asText(record.title) || asText(record.text) || asText(record.task);
    if (!content) continue;
    let status = asStatus(record.status);
    if (status === "in_progress") {
      if (inProgress) status = "pending";
      else inProgress = true;
    }
    const activeForm = asText(record.activeForm) || asText(record.active_form);
    todos.push({
      id: asText(record.id) || String(index + 1),
      content,
      status,
      ...(activeForm ? { activeForm } : {}),
    });
  }
  return todos;
}

function reconstruct(ctx: ExtensionContext): Todo[] {
  let todos: Todo[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; toolName?: string; details?: unknown };
    if (message.role !== "toolResult" || message.toolName !== TOOL) continue;
    const details = message.details as TodoDetails | undefined;
    if (Array.isArray(details?.todos)) todos = details.todos;
  }
  return todos;
}

function reminder(todos: Todo[]): string | null {
  const open = todos.filter((item) => item.status === "pending" || item.status === "in_progress");
  if (open.length === 0) return null;
  const lines = todos.map((item) => `- [${mark(item.status)}] ${item.content}`);
  return [
    "## Current todos (from earlier in this session)",
    "These items are still unfinished. If the user's current request continues that work, keep updating the list as you go (send the complete list each time, exactly one item in_progress). If it is a different request, ignore this list — do not resume it just because it is unfinished — and replace it with a new one when the new work warrants a checklist.",
    ...lines,
  ].join("\n");
}

export default function todoExtension(pi: ExtensionAPI): void {
  let todos: Todo[] = [];

  pi.registerTool({
    name: TOOL,
    label: "待办",
    description: DESCRIPTION,
    promptSnippet: "Replace the session todo list (pending / in_progress / completed / cancelled)",
    promptGuidelines: [
      "Use todo for multi-step or non-trivial work: send the complete list on every call, keep exactly one item in_progress, and mark an item completed only after that step is fully done.",
      "Skip todo for a single straightforward task, a trivial <3-step change, or a question.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: "Imperative task, e.g. \"Run tests\"" }),
          status: StringEnum(STATUSES, { description: "pending | in_progress | completed | cancelled" }),
          activeForm: Type.Optional(
            Type.String({ description: "Present-continuous form shown while in_progress, e.g. \"Running tests\"" }),
          ),
          id: Type.Optional(Type.String({ description: "Stable id; assigned if omitted" })),
        }),
        { minItems: 1, description: "The complete todo list; replaces the previous list" },
      ),
    }),
    async execute(_toolCallId, params) {
      const next = normalize(params.todos ?? []);
      if (next.length === 0) {
        return {
          content: [{ type: "text", text: "Error: todos must contain at least one item with content." }],
          details: { todos: [...todos] } satisfies TodoDetails,
        };
      }
      todos = next;
      return {
        content: [{ type: "text", text: formatList(todos) }],
        details: { todos: [...todos] } satisfies TodoDetails,
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    todos = reconstruct(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    todos = reconstruct(ctx);
  });

  pi.on("before_agent_start", (event) => {
    const extra = reminder(todos);
    if (!extra) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });
}
