import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon, FileCodeIcon, FileMinusIcon, FilePlusIcon, FileTextIcon, FolderTreeIcon, ListChecksIcon, Plug01Icon, Search01Icon, SparklesIcon, SquareTerminalIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import type { ToolCallBlock } from "@shared/types";
import { parseToolTodos } from "./todos";

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
  | "list"
  | "terminal"
  | "skill"
  | "agent"
  | "todo"
  | "mcp"
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

/** Progressive and category labels per family, following zcode's verb forms. */
const LABELS: Record<ToolFamily, { running: string; done: string }> = {
  read: { running: "正在读取", done: "读取" },
  edit: { running: "正在编辑", done: "编辑" },
  write: { running: "正在写入", done: "写入" },
  delete: { running: "正在删除", done: "删除" },
  search: { running: "正在搜索", done: "搜索" },
  list: { running: "正在列出", done: "列出" },
  terminal: { running: "正在执行", done: "终端" },
  skill: { running: "正在运行技能", done: "技能" },
  agent: { running: "子智能体运行中", done: "子智能体" },
  todo: { running: "正在更新待办", done: "待办" },
  mcp: { running: "正在调用", done: "工具调用" },
  other: { running: "正在运行", done: "工具调用" },
};

const ICONS: Record<ToolFamily, ReactNode> = {
  read: <HugeiconsIcon strokeWidth={2} icon={FileTextIcon} className="size-3.5" />,
  edit: <HugeiconsIcon strokeWidth={2} icon={FileCodeIcon} className="size-3.5" />,
  write: <HugeiconsIcon strokeWidth={2} icon={FilePlusIcon} className="size-3.5" />,
  delete: <HugeiconsIcon strokeWidth={2} icon={FileMinusIcon} className="size-3.5" />,
  search: <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="size-3.5" />,
  list: <HugeiconsIcon strokeWidth={2} icon={FolderTreeIcon} className="size-3.5" />,
  terminal: <HugeiconsIcon strokeWidth={2} icon={SquareTerminalIcon} className="size-3.5" />,
  skill: <HugeiconsIcon strokeWidth={2} icon={SparklesIcon} className="size-3.5" />,
  agent: <HugeiconsIcon strokeWidth={2} icon={BotIcon} className="size-3.5" />,
  todo: <HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} className="size-3.5" />,
  mcp: <HugeiconsIcon strokeWidth={2} icon={Plug01Icon} className="size-3.5" />,
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
  if (/^(read|read_file|readfile|view|cat)$/.test(key)) return "read";
  if (/^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$/.test(key)) return "edit";
  if (/^(write|write_file|writefile|create_file|createfile|create)$/.test(key)) return "write";
  if (/^(delete|delete_file|remove|remove_file|rm)$/.test(key)) return "delete";
  if (/^(grep|search|search_files|searchfiles|ripgrep|rg|web_search|websearch|fetch|webfetch)$/.test(key)) return "search";
  if (/^(find|glob|ls|list|list_dir|listdir|tree|list_files|listfiles)$/.test(key)) return "list";
  if (/^(bash|shell|shell_exec|shellexec|exec|execute|run_command|runcommand|command|terminal|run)$/.test(key)) return "terminal";
  if (key.includes("skill")) return "skill";
  if (/^(task|agent|subagent|dispatch|delegate)/.test(key)) return "agent";
  if (key.includes("todo")) return "todo";
  return "other";
}

/** Fold the summary into a verb + object + muted context, as zcode does. */
export function describeTool(tool: ToolCallBlock): ToolView {
  const family = familyOf(tool.name);
  const labels = LABELS[family];
  const running = tool.status === "running";
  const label = running ? labels.running : labels.done;
  const statusLabel = tool.status === "error" ? "执行失败" : undefined;
  const view: ToolView = { family, icon: ICONS[family], label, statusLabel, running };

  switch (family) {
    case "read":
    case "edit":
    case "write":
    case "delete": {
      const path = argString(tool.args, FILE_PATH_KEYS);
      if (path) {
        view.subject = basename(path);
        view.context = dirname(path);
        view.title = path;
      } else {
        view.subject = tool.name;
      }
      return view;
    }
    case "search": {
      const query = argString(tool.args, SEARCH_KEYS);
      const glob = argString(tool.args, ["glob"]);
      view.subject = query || tool.name;
      view.context = glob || undefined;
      view.title = [query, glob].filter(Boolean).join(" · ") || tool.name;
      return view;
    }
    case "list": {
      const path = argString(tool.args, ["path", "dir", "directory", "pattern"]);
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
    case "todo": {
      const todos = parseToolTodos(tool);
      if (todos.length > 0) {
        const done = todos.filter((item) => item.status === "completed").length;
        const allDone = done === todos.length;
        view.label = running || !allDone ? "正在更新待办" : "已更新待办";
        const current =
          todos.find((item) => item.status === "in_progress") ??
          todos.find((item) => item.status !== "completed" && item.status !== "cancelled") ??
          todos.at(-1);
        const count = `${done}/${todos.length}`;
        view.subject = current ? `${count} · ${current.content}` : count;
        view.title = current?.content ?? count;
      } else {
        view.subject = tool.name;
      }
      return view;
    }
    default: {
      view.subject = tool.name;
      view.title = tool.name;
      return view;
    }
  }
}

/** Single-line command/prose summary used by group rows. */
export function toolSubject(tool: ToolCallBlock): string {
  const view = describeTool(tool);
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
