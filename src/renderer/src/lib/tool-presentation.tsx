import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon, ChromeIcon, ComputerIcon, FileEditIcon, FileMinusIcon, FilePlusIcon, FileTextIcon, FolderTreeIcon, ListChecksIcon, MessageQuestionIcon, Plug01Icon, Search01Icon, SparklesIcon, SquareTerminalIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import type { ToolCallBlock } from "@shared/types";
import { i18n } from "@/lib/i18n";
import { activeTodo, parseToolTodos, todoIndexOf } from "./todos";
import { displayPath } from "./workspace-path";

/**
 * Tool presentation, modelled on zcode's tool-call language.
 *
 * The engine names tools (`read`, `edit`, `bash`, …); the UI never shows those raw
 * names. Each tool maps to a family that owns a category label, a progressive label
 * for the running state, an icon, and the shape of its one-line summary.
 */

export type ToolFamily =
  | "read"
  | "edit"
  | "write"
  | "delete"
  | "search"
  | "web"
  | "list"
  | "terminal"
  | "skill"
  | "agent"
  | "todo"
  | "question"
  | "mcp"
  | "browser"
  | "other";

export type ToolView = {
  family: ToolFamily;
  icon: ReactNode;
  /** Category noun, or the progressive verb while running: 「读取」/「正在读取」. */
  label: string;
  /** What the tool acted on: file name, command, search query, tool name. */
  subject?: string;
  /** Muted trailing context: directory, glob, or the raw tool name. */
  context?: string;
  /**
   * A short tag that must stay visible however long the subject is (context is the
   * flexible item and is the first thing a long subject squeezes out).
   */
  badge?: string;
  /** Only rendered when the tool failed. */
  statusLabel?: string;
  /** Full value for the native title tooltip. */
  title?: string;
  /** True while the engine is still executing this call. */
  running: boolean;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read the first non-empty string among `keys`, mirroring zcode's ordered probing. */
export function argString(args: unknown, keys: string[]): string {
  const record = asRecord(args);
  if (!record) return typeof args === "string" ? args.trim() : "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

function dirname(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : "";
}

/** Progressive and category labels per family, following zcode's verb forms.
 *
 * Resolved per call rather than stored in a record: a record is built once at
 * module load and would freeze the language (these strings are rendered during
 * render, so the current language is the right one).
 */
function familyLabel(family: ToolFamily, running: boolean): string {
  return i18n.t(`common:tool.${family}.${running ? "running" : "done"}`) as string;
}

const ICONS: Record<ToolFamily, ReactNode> = {
  read: <HugeiconsIcon strokeWidth={2} icon={FileTextIcon} className="size-3.5" />,
  edit: <HugeiconsIcon strokeWidth={2} icon={FileEditIcon} className="size-3.5" />,
  write: <HugeiconsIcon strokeWidth={2} icon={FilePlusIcon} className="size-3.5" />,
  delete: <HugeiconsIcon strokeWidth={2} icon={FileMinusIcon} className="size-3.5" />,
  search: <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="size-3.5" />,
  web: <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="size-3.5" />,
  list: <HugeiconsIcon strokeWidth={2} icon={FolderTreeIcon} className="size-3.5" />,
  terminal: <HugeiconsIcon strokeWidth={2} icon={SquareTerminalIcon} className="size-3.5" />,
  skill: <HugeiconsIcon strokeWidth={2} icon={SparklesIcon} className="size-3.5" />,
  agent: <HugeiconsIcon strokeWidth={2} icon={BotIcon} className="size-3.5" />,
  todo: <HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} className="size-3.5" />,
  question: <HugeiconsIcon strokeWidth={2} icon={MessageQuestionIcon} className="size-3.5" />,
  mcp: <HugeiconsIcon strokeWidth={2} icon={Plug01Icon} className="size-3.5" />,
  browser: <HugeiconsIcon strokeWidth={2} icon={ChromeIcon} className="size-3.5" />,
  other: <HugeiconsIcon strokeWidth={2} icon={Wrench01Icon} className="size-3.5" />,
};

const FILE_PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "target"];
const SEARCH_KEYS = ["search_query", "searchQuery", "query", "pattern", "regex", "path", "url", "prompt", "target", "name"];
const COMMAND_KEYS = ["command", "cmd", "script", "parsed_cmd"];

/** Map an engine tool name onto a family. MCP tools keep their own family. */
export function familyOf(name: string): ToolFamily {
  const key = name.trim().toLowerCase();
  if (!key) return "other";
  if (key.startsWith("mcp") || key.includes("__")) return "mcp";
  if (key.startsWith("browser_")) return "browser";
  if (/^(read|read_file|readfile|view|cat)$/.test(key)) return "read";
  if (/^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$/.test(key)) return "edit";
  if (/^(write|write_file|writefile|create_file|createfile|create)$/.test(key)) return "write";
  if (/^(delete|delete_file|remove|remove_file|rm)$/.test(key)) return "delete";
  if (/^(web_search|websearch)$/.test(key)) return "web";
  if (/^(grep|search|search_files|searchfiles|ripgrep|rg|fetch|webfetch|conversation_search)$/.test(key)) return "search";
  if (/^(find|glob|ls|list|list_dir|listdir|tree|list_files|listfiles)$/.test(key)) return "list";
  if (/^(bash|shell|shell_exec|shellexec|exec|execute|run_command|runcommand|command|terminal|run)$/.test(key)) return "terminal";
  if (key.includes("skill")) return "skill";
  if (/^(task|agent|subagent|dispatch|delegate)/.test(key)) return "agent";
  if (key.includes("todo")) return "todo";
  if (/^(question|ask_user|askuser|questionnaire)$/.test(key)) return "question";
  return "other";
}

/** Entries of a `question` tool call's `questions` array, for the summary row. */
export function questionItems(args: unknown): Array<Record<string, unknown>> {
  const list = asRecord(args)?.questions;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is Record<string, unknown> => asRecord(item) !== null);
}

/**
 * Fold the summary into a verb + object + muted context, as zcode does.
 *
 * `cwd` is the conversation's working directory: the engine addresses files
 * absolutely, and every path printed here is shortened to its project-relative
 * form so the row names the file's place in the project instead of the user's home
 * directory. Callers pass the value from `useWorkspacePath()`.
 */
export function describeTool(tool: ToolCallBlock, cwd?: string): ToolView {
  const family = familyOf(tool.name);
  const running = tool.status === "running";
  const label = familyLabel(family, running);
  const statusLabel = tool.status === "error" ? (i18n.t("common:tool.failed") as string) : undefined;
  const view: ToolView = { family, icon: ICONS[family], label, statusLabel, running };
  if (tool.name === "browser_task" || tool.name === "computer_task") return describeDecisionTask(tool, view);

  switch (family) {
    case "read":
    case "edit":
    case "write":
    case "delete": {
      const path = argString(tool.args, FILE_PATH_KEYS);
      if (path) {
        const shown = displayPath(path, cwd);
        view.subject = basename(shown);
        view.context = dirname(shown);
        view.title = shown;
      } else {
        view.subject = tool.name;
      }
      return view;
    }
    case "search": {
      const query = displayPath(argString(tool.args, SEARCH_KEYS), cwd);
      const glob = argString(tool.args, ["glob"]);
      const conversationId = argString(tool.args, ["conversationId"]);
      view.subject = query || tool.name;
      view.context = glob || conversationId || undefined;
      view.title = [query, glob || conversationId].filter(Boolean).join(" · ") || tool.name;
      return view;
    }
    case "web": {
      const query = argString(tool.args, ["query", "search_query", "searchQuery"]);
      view.subject = query || tool.name;
      view.title = query || tool.name;
      const sources = asRecord(tool.details)?.sources;
      if (Array.isArray(sources) && sources.length > 0) {
        view.context = i18n.t("common:tool.webSources", { count: sources.length }) as string;
      }
      return view;
    }
    case "list": {
      const path = displayPath(argString(tool.args, ["path", "dir", "directory", "pattern"]), cwd);
      view.subject = path || ".";
      view.title = path || tool.name;
      return view;
    }
    case "terminal": {
      const command = argString(tool.args, COMMAND_KEYS);
      view.subject = command || tool.name;
      view.title = command || tool.name;
      return view;
    }
    case "skill": {
      const name = argString(tool.args, ["skill", "name", "command"]);
      view.subject = name || tool.name;
      view.title = name || tool.name;
      return view;
    }
    case "question": {
      const items = questionItems(tool.args);
      const first = typeof items[0]?.question === "string" ? (items[0].question as string).trim() : "";
      view.subject = first || (i18n.t("common:tool.questionFallback") as string);
      view.context =
        items.length > 1 ? (i18n.t("common:tool.questionCount", { count: items.length }) as string) : undefined;
      view.title = first || tool.name;
      return view;
    }
    case "todo": {
      const todos = parseToolTodos(tool);
      if (todos.length > 0) {
        const done = todos.filter((item) => item.status === "completed").length;
        const allDone = done === todos.length;
        view.label =
          running || !allDone
            ? (i18n.t("common:tool.todoUpdating") as string)
            : (i18n.t("common:tool.todoUpdated") as string);
        const current = activeTodo(todos) ?? todos.at(-1);
        // Position in the list, not the completed count — see `todoPosition`.
        const count = `${todoIndexOf(todos, current)}/${todos.length}`;
        const label =
          current?.status === "in_progress" && current.activeForm ? current.activeForm : current?.content;
        view.subject = current ? `${count} · ${label}` : count;
        view.title = label ?? count;
      } else {
        view.subject = tool.name;
      }
      return view;
    }
    case "browser": {
      const target = argString(tool.args, ["url", "text", "selector", "tabId", "key"]);
      view.subject = target || tool.name.replace(/^browser_/, "");
      view.title = target || tool.name;
      return view;
    }
    case "agent": {
      const args = asRecord(tool.args);
      const names: string[] = [];
      if (typeof args?.agent === "string") names.push(args.agent);
      for (const key of ["tasks", "chain"]) {
        if (Array.isArray(args?.[key])) for (const item of args[key] as unknown[]) {
          const record = asRecord(item);
          if (typeof record?.agent === "string") names.push(record.agent);
        }
      }
      // A wide fan-out (say five scouts) would otherwise repeat the role five times
      // and push the count off screen. Collapse to at most two distinct roles plus a
      // count; the expanded panel lists every run.
      const counts = new Map<string, number>();
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      const distinct = [...counts.entries()];
      const shown = distinct
        .slice(0, 2)
        .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
        .join(", ");
      const compact =
        distinct.length > 2
          ? (i18n.t("common:tool.agentMore", { shown, count: names.length }) as string)
          : shown;
      view.subject = compact || (i18n.t("common:tool.agentFallback") as string);
      view.title = names.join(", ") || tool.name;
      return view;
    }
    default: {
      view.subject = tool.name;
      view.title = tool.name;
      return view;
    }
  }
}

/**
 * `browser_task` / `computer_task`: a whole run decided by the decision model (Jev), not
 * one step. The row says so — which engine, how many steps, how long, and whether it got
 * to the end — because the only other way to tell a Jev run from the main model clicking
 * through `browser_*` tools itself was to open the raw result.
 */
function describeDecisionTask(tool: ToolCallBlock, view: ToolView): ToolView {
  const computer = tool.name === "computer_task";
  view.icon = computer ? <HugeiconsIcon strokeWidth={2} icon={ComputerIcon} className="size-3.5" /> : ICONS.browser;
  view.label = i18n.t(`common:tool.${computer ? "computerTask" : "browserTask"}.${view.running ? "running" : "done"}`) as string;
  const goal = argString(tool.args, ["goal"]);
  view.subject = goal || tool.name;
  view.title = goal || tool.name;
  const result = asRecord(tool.details) ?? parsedResult(tool.result);
  const engine = typeof result?.backend === "string" && result.backend === "jev" ? "Jev" : typeof result?.backend === "string" ? result.backend : "Jev";
  if (view.running) {
    view.badge = i18n.t("common:tool.decisionRunning", { engine }) as string;
    return view;
  }
  if (!result) return view;
  const steps = Array.isArray(result.steps) ? result.steps.length : 0;
  const seconds = typeof result.ms === "number" ? (result.ms / 1000).toFixed(1) : undefined;
  const parts = [engine, i18n.t("common:tool.decisionSteps", { count: steps }) as string];
  if (seconds) parts.push(i18n.t("common:tool.decisionSeconds", { seconds }) as string);
  if (typeof result.status === "string" && result.status !== "done") {
    parts.push(i18n.t(`common:tool.decisionStatus.${result.status}`, { defaultValue: result.status }) as string);
  }
  view.badge = parts.join(" · ");
  return view;
}

/** The tool's text result as an object, when it is the JSON a task tool returns. */
function parsedResult(text: string | undefined): Record<string, unknown> | null {
  if (!text?.trim().startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Single-line command/prose summary used by group rows. */
export function toolSubject(tool: ToolCallBlock, cwd?: string): string {
  const view = describeTool(tool, cwd);
  return [view.subject, view.context].filter(Boolean).join(" · ") || tool.name;
}

/**
 * Unwrap `zsh -lc "…"` wrappers the engine sometimes uses, so the terminal panel
 * header shows the command the user actually cares about.
 */
export function unwrapShellCommand(command: string): string {
  const match = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i.exec(command.trim());
  const inner = match?.[1]?.trim();
  if (!inner) return command.trim();
  if ((inner.startsWith("\"") && inner.endsWith("\"")) || (inner.startsWith("'") && inner.endsWith("'"))) {
    return inner.slice(1, -1).trim();
  }
  return inner;
}
