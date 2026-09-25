import { memo, type JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import type { IconSvgElement } from "@hugeicons/react-native";
import {
  BotIcon,
  ChromeIcon,
  FileEditIcon,
  FileMinusIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderTreeIcon,
  ListChecksIcon,
  MessageQuestionIcon,
  Plug01Icon,
  Search01Icon,
  SparklesIcon,
  SquareTerminalIcon,
  Wrench01Icon,
} from "../ui/icons";
import type { Palette } from "../ui/theme";
import { DesktopSpinner } from "./desktop-spinner";

/**
 * Mobile intentionally keeps tool calls as one compact transcript row.
 *
 * Desktop has room for a disclosure panel with parameters, output and diffs. On a
 * phone those bodies make a reply jump several screens and bury the answer. The
 * mobile row therefore answers only the useful question: what is the agent doing,
 * and what is it doing it to?
 */
export type ToolBlock = {
  id: string;
  name: string;
  args?: unknown;
  result?: string;
  status?: string;
  details?: unknown;
};

type ToolFamily =
  | "read" | "edit" | "write" | "delete" | "search" | "web"
  | "list" | "terminal" | "skill" | "agent" | "todo" | "question"
  | "mcp" | "browser" | "other";

type ToolSummary = {
  family: ToolFamily;
  icon: IconSvgElement;
  label: string;
  subject: string;
  context?: string;
  error?: boolean;
  running: boolean;
};

const LABELS: Record<ToolFamily, [done: string, running: string]> = {
  read: ["读取", "正在读取"],
  edit: ["编辑", "正在编辑"],
  write: ["写入", "正在写入"],
  delete: ["删除", "正在删除"],
  search: ["搜索", "正在搜索"],
  web: ["网络搜索", "正在搜索网页"],
  list: ["列出", "正在列出"],
  terminal: ["终端", "正在执行"],
  skill: ["技能", "正在运行技能"],
  agent: ["子 Agent", "子 Agent 运行中"],
  todo: ["待办", "正在更新待办"],
  question: ["询问", "正在询问"],
  mcp: ["工具调用", "正在调用"],
  browser: ["浏览器", "正在操作浏览器"],
  other: ["工具调用", "正在运行"],
};

const ICONS: Record<ToolFamily, IconSvgElement> = {
  read: FileTextIcon,
  edit: FileEditIcon,
  write: FilePlusIcon,
  delete: FileMinusIcon,
  search: Search01Icon,
  web: Search01Icon,
  list: FolderTreeIcon,
  terminal: SquareTerminalIcon,
  skill: SparklesIcon,
  agent: BotIcon,
  todo: ListChecksIcon,
  question: MessageQuestionIcon,
  mcp: Plug01Icon,
  browser: ChromeIcon,
  other: Wrench01Icon,
};

const FILE_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "target"];
const SEARCH_KEYS = ["search_query", "searchQuery", "query", "pattern", "regex", "path", "url", "prompt", "target", "name"];
const COMMAND_KEYS = ["command", "cmd", "script", "parsed_cmd"];

export const ToolCard = memo(function ToolCard({ tool, palette }: { tool: ToolBlock; palette: Palette }): JSX.Element {
  const summary = summarize(tool);
  return (
    <View style={styles.row}>
      <View style={styles.icon}>
        {summary.running ? (
          <DesktopSpinner size={15} color={palette.accent} />
        ) : (
          <HugeiconsIcon icon={summary.icon} size={15} color={summary.error ? palette.danger : palette.muted} strokeWidth={2} />
        )}
      </View>
      <Text style={[styles.label, { color: summary.running ? palette.accent : palette.muted }]} numberOfLines={1}>
        {summary.label}
      </Text>
      <Text style={[styles.subject, { color: palette.text }]} numberOfLines={1} ellipsizeMode="middle">
        {summary.subject}
      </Text>
      {summary.context ? (
        <Text style={[styles.context, { color: palette.muted }]} numberOfLines={1} ellipsizeMode="tail">
          {summary.context}
        </Text>
      ) : null}
      {summary.error ? <Text style={[styles.error, { color: palette.danger }]}>失败</Text> : null}
    </View>
  );
});

function summarize(tool: ToolBlock): ToolSummary {
  const family = familyOf(tool.name);
  const running = tool.status === "running";
  const summary: ToolSummary = {
    family,
    icon: ICONS[family],
    label: running ? LABELS[family][1] : LABELS[family][0],
    subject: tool.name,
    running,
    error: tool.status === "error",
  };

  switch (family) {
    case "read":
    case "edit":
    case "write":
    case "delete": {
      const path = argString(tool.args, FILE_KEYS);
      summary.subject = path ? basename(path) : friendlyName(tool.name);
      if (path) summary.context = dirname(path);
      break;
    }
    case "search": {
      if (tool.name === "memory_recent") {
        summary.subject = "最近的记忆";
        summary.context = "长期记忆";
        break;
      }
      if (tool.name === "memory_search") {
        summary.subject = argString(tool.args, ["query"]) || "长期记忆";
        summary.context = "记忆";
        break;
      }
      summary.subject = argString(tool.args, SEARCH_KEYS) || friendlyName(tool.name);
      const glob = argString(tool.args, ["glob"]);
      if (glob) summary.context = glob;
      break;
    }
    case "web": {
      summary.subject = argString(tool.args, ["query", "search_query", "searchQuery"]) || "网页";
      const sources = asRecord(tool.details)?.sources;
      if (Array.isArray(sources) && sources.length > 0) summary.context = `${sources.length} 个来源`;
      break;
    }
    case "list": {
      summary.subject = argString(tool.args, ["path", "dir", "directory", "pattern"]) || ".";
      break;
    }
    case "terminal":
      summary.subject = argString(tool.args, COMMAND_KEYS) || "执行命令";
      break;
    case "skill":
      summary.subject = argString(tool.args, ["skill", "name", "command"]) || friendlyName(tool.name);
      break;
    case "question": {
      const questions = asRecord(tool.args)?.questions;
      const firstQuestion = Array.isArray(questions) ? asRecord(questions[0])?.question : undefined;
      const first = typeof firstQuestion === "string" ? firstQuestion.trim() : "";
      summary.subject = first || "澄清问题";
      if (Array.isArray(questions) && questions.length > 1) summary.context = `${questions.length} 个问题`;
      break;
    }
    case "todo": {
      const todos = todoItems(tool);
      const current = todos.find((item) => item.status === "in_progress") ?? todos.find((item) => item.status === "pending");
      const done = todos.filter((item) => item.status === "completed" || item.status === "cancelled").length;
      if (todos.length > 0) {
        const index = current ? todos.indexOf(current) + 1 : todos.length;
        summary.subject = `${index}/${todos.length}${current?.content ? ` · ${current.content}` : ""}`;
        summary.context = `${done}/${todos.length} 已完成`;
      } else {
        summary.subject = "更新清单";
      }
      break;
    }
    case "agent": {
      const roles = agentRoles(tool.args);
      summary.subject = roles.length > 0 ? compactRoles(roles) : "子 Agent";
      if (roles.length > 1) summary.context = `${roles.length} 个任务`;
      break;
    }
    case "browser":
      summary.subject = argString(tool.args, ["url", "text", "selector", "tabId", "key"]) || friendlyName(tool.name.replace(/^browser_/, ""));
      break;
    default:
      summary.subject = friendlyName(tool.name);
  }
  return summary;
}

function familyOf(name: string): ToolFamily {
  const key = name.trim().toLowerCase();
  if (!key) return "other";
  if (key.startsWith("mcp") || key.includes("__")) return "mcp";
  if (key.startsWith("browser_")) return "browser";
  if (/^(read|read_file|readfile|view|cat)$/.test(key)) return "read";
  if (/^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$/.test(key)) return "edit";
  if (/^(write|write_file|writefile|create_file|createfile|create)$/.test(key)) return "write";
  if (/^(delete|delete_file|remove|remove_file|rm)$/.test(key)) return "delete";
  if (/^(web_search|websearch)$/.test(key)) return "web";
  if (/^(grep|search|search_files|searchfiles|ripgrep|rg|fetch|webfetch|conversation_search|memory_search|memory_recent)$/.test(key)) return "search";
  if (/^(find|glob|ls|list|list_dir|listdir|tree|list_files|listfiles)$/.test(key)) return "list";
  if (/^(bash|shell|shell_exec|shellexec|exec|execute|run_command|runcommand|command|terminal|run)$/.test(key)) return "terminal";
  if (key.includes("skill")) return "skill";
  if (/^(task|agent|subagent|dispatch|delegate)/.test(key)) return "agent";
  if (key.includes("todo")) return "todo";
  if (/^(question|ask_user|askuser|questionnaire)$/.test(key)) return "question";
  return "other";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function argString(args: unknown, keys: string[]): string {
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
  return parts.join("/");
}

function friendlyName(name: string): string {
  return name.replace(/^(browser_|mcp__)/, "").replace(/[_-]+/g, " ");
}

type TodoItem = { status?: string; content?: string };
function todoItems(tool: ToolBlock): TodoItem[] {
  const details = asRecord(tool.details);
  const raw = Array.isArray(details?.todos) ? details.todos : asRecord(tool.args)?.todos;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const record = asRecord(item);
    return record ? [{ status: typeof record.status === "string" ? record.status : undefined, content: typeof record.content === "string" ? record.content : typeof record.activeForm === "string" ? record.activeForm : undefined }] : [];
  });
}

function agentRoles(args: unknown): string[] {
  const record = asRecord(args);
  if (!record) return [];
  const roles: string[] = [];
  if (typeof record.agent === "string") roles.push(record.agent);
  for (const key of ["tasks", "chain"]) {
    if (!Array.isArray(record[key])) continue;
    for (const item of record[key] as unknown[]) {
      const value = asRecord(item)?.agent;
      if (typeof value === "string") roles.push(value);
    }
  }
  return roles;
}

function compactRoles(roles: string[]): string {
  const counts = new Map<string, number>();
  for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  return [...counts.entries()].slice(0, 2).map(([role, count]) => count > 1 ? `${role} ×${count}` : role).join(", ");
}

const styles = StyleSheet.create({
  row: { width: "100%", minHeight: 23, flexDirection: "row", alignItems: "center", gap: 6 },
  icon: { width: 16, alignItems: "center", justifyContent: "center" },
  label: { flexShrink: 0, fontSize: 14, fontWeight: "500" },
  subject: { flexShrink: 1, minWidth: 0, fontFamily: "monospace", fontSize: 13 },
  context: { flexShrink: 1, maxWidth: "32%", fontFamily: "monospace", fontSize: 12, opacity: 0.65 },
  error: { flexShrink: 0, fontSize: 12, fontWeight: "600" },
});
