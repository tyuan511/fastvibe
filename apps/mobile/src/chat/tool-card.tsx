import { memo, useState, type JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import type { IconSvgElement } from "@hugeicons/react-native";
import {
  ArrowRight01Icon,
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
import { ThinkingRow } from "./thinking";
import { t, useT, type MessageKey } from "../i18n";

/**
 * Mobile keeps each tool call to one compact transcript row until it is tapped.
 *
 * Desktop has room for a disclosure panel with parameters, output and diffs. On a
 * phone those bodies make a reply jump several screens and bury the answer. The
 * collapsed row therefore answers only the useful question — what is the agent doing,
 * and what is it doing it to? — and the input and the output's tail wait behind a tap.
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

const LABELS: Record<ToolFamily, [done: MessageKey, running: MessageKey]> = {
  read: ["tool.read", "tool.readRunning"],
  edit: ["tool.edit", "tool.editRunning"],
  write: ["tool.write", "tool.writeRunning"],
  delete: ["tool.delete", "tool.deleteRunning"],
  search: ["tool.search", "tool.searchRunning"],
  web: ["tool.web", "tool.webRunning"],
  list: ["tool.list", "tool.listRunning"],
  terminal: ["tool.terminal", "tool.terminalRunning"],
  skill: ["tool.skill", "tool.skillRunning"],
  agent: ["tool.agent", "tool.agentRunning"],
  todo: ["tool.todo", "tool.todoRunning"],
  question: ["tool.question", "tool.questionRunning"],
  mcp: ["tool.mcp", "tool.mcpRunning"],
  browser: ["tool.browser", "tool.browserRunning"],
  other: ["tool.other", "tool.otherRunning"],
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

/** One row of a process card: a stretch of thinking, or a tool call. */
export type ProcessItem = { kind: "thinking"; text: string } | { kind: "tool"; tool: ToolBlock };

/**
 * A reply's working between two pieces of prose — its thinking and every tool call —
 * drawn as one card, one line each, even across the model's round trips: nothing a
 * reader needs sits between them, and a card per call made a busy turn a column of
 * boxes. A tap on a line opens what it ran and what came back. Collapsed is still the
 * default — the reply stays the thing on screen — but a phone is often the only screen
 * the user has, and a failed command whose output cannot be read at all is a dead end.
 */
export const ProcessGroup = memo(function ProcessGroup({
  items,
  palette,
  live = false,
}: {
  items: ProcessItem[];
  palette: Palette;
  /** The reply is still streaming, so a trailing thinking row is in progress. */
  live?: boolean;
}): JSX.Element {
  return (
    <View style={[styles.group, { backgroundColor: palette.card, borderColor: palette.border }]}>
      {items.map((item, index) => {
        const divider = index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator } : null;
        return item.kind === "tool" ? (
          <ToolCard key={item.tool.id} tool={item.tool} palette={palette} divider={index > 0} />
        ) : (
          <View key={`thinking-${index}`} style={divider}>
            <ThinkingRow text={item.text} palette={palette} live={live && index === items.length - 1} />
          </View>
        );
      })}
    </View>
  );
});

export const ToolCard = memo(function ToolCard({ tool, palette, divider = false }: { tool: ToolBlock; palette: Palette; divider?: boolean }): JSX.Element {
  useT();
  const summary = summarize(tool);
  const [open, setOpen] = useState(false);
  const detail = open ? toolDetail(tool) : null;
  const tint = summary.error ? palette.danger : summary.running ? palette.accent : palette.muted;
  return (
    <View style={divider ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator } : null}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${summary.label} ${summary.subject}`.trim()}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: palette.field } : null]}
      >
        <View style={[styles.icon, { backgroundColor: summary.error ? palette.dangerSoft : summary.running ? palette.accentSoft : palette.field }]}>
          {summary.running ? (
            <DesktopSpinner size={13} color={palette.accent} />
          ) : (
            <HugeiconsIcon icon={summary.icon} size={13} color={tint} strokeWidth={2} />
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
        <View style={styles.spacer} />
        {summary.error ? <Text style={[styles.error, { color: palette.danger }]}>{t("tool.failed")}</Text> : null}
        <View style={open ? styles.chevronOpen : undefined}><HugeiconsIcon icon={ArrowRight01Icon} size={14} color={palette.subtle} strokeWidth={2} /></View>
      </Pressable>
      {detail ? (
        <View style={styles.detail}>
          {detail.input ? (
            <View style={[styles.block, { backgroundColor: palette.field }]}>
              <Text style={[styles.blockLabel, { color: palette.muted }]}>{detail.inputLabel}</Text>
              <Text selectable style={[styles.blockText, { color: palette.text }]}>{detail.input}</Text>
            </View>
          ) : null}
          {detail.output ? (
            <View style={[styles.block, { backgroundColor: palette.field }]}>
              <Text style={[styles.blockLabel, { color: summary.error ? palette.danger : palette.muted }]}>{summary.error ? t("tool.error") : t("tool.output")}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable style={[styles.blockText, { color: summary.error ? palette.danger : palette.text }]}>{detail.output}</Text>
              </ScrollView>
            </View>
          ) : !summary.running ? (
            <Text style={[styles.noOutput, { color: palette.muted }]}>{t("tool.noOutput")}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const OUTPUT_LINES = 40;
const OUTPUT_CHARS = 4000;

/** What a tapped row shows: the call's input in its most readable form, then the output's tail. */
function toolDetail(tool: ToolBlock): { inputLabel: string; input: string; output: string } {
  const family = familyOf(tool.name);
  let inputLabel = t("tool.args");
  let input = "";
  if (family === "terminal") {
    inputLabel = t("tool.command");
    input = argString(tool.args, COMMAND_KEYS);
  } else if (family === "read" || family === "edit" || family === "write" || family === "delete") {
    inputLabel = t("tool.file");
    input = argString(tool.args, FILE_KEYS);
  }
  if (!input && tool.args !== undefined) {
    try {
      input = typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args, null, 2);
    } catch {
      input = "";
    }
  }
  return { inputLabel, input: clip(input, 1600, 24, "head"), output: clip(tool.result ?? "", OUTPUT_CHARS, OUTPUT_LINES, "tail") };
}

/** Bound a block for a phone: long output keeps its end (where errors are), long input its start. */
function clip(text: string, chars: number, lines: number, keep: "head" | "tail"): string {
  const trimmed = text.replace(/\s+$/, "");
  const all = trimmed.split("\n");
  let out = all.length > lines ? (keep === "tail" ? all.slice(-lines) : all.slice(0, lines)).join("\n") : trimmed;
  if (out.length > chars) out = keep === "tail" ? out.slice(-chars) : out.slice(0, chars);
  if (out.length === trimmed.length) return out;
  return keep === "tail" ? `…\n${out}` : `${out}\n…`;
}

function summarize(tool: ToolBlock): ToolSummary {
  const family = familyOf(tool.name);
  const running = tool.status === "running";
  const summary: ToolSummary = {
    family,
    icon: ICONS[family],
    label: t(running ? LABELS[family][1] : LABELS[family][0]),
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
        summary.subject = t("tool.recentMemory");
        summary.context = t("tool.longTermMemory");
        break;
      }
      if (tool.name === "memory_search") {
        summary.subject = argString(tool.args, ["query"]) || t("tool.longTermMemory");
        summary.context = t("tool.memory");
        break;
      }
      summary.subject = argString(tool.args, SEARCH_KEYS) || friendlyName(tool.name);
      const glob = argString(tool.args, ["glob"]);
      if (glob) summary.context = glob;
      break;
    }
    case "web": {
      summary.subject = argString(tool.args, ["query", "search_query", "searchQuery"]) || t("tool.webPage");
      const sources = asRecord(tool.details)?.sources;
      if (Array.isArray(sources) && sources.length > 0) summary.context = t("tool.sources", { count: sources.length });
      break;
    }
    case "list": {
      summary.subject = argString(tool.args, ["path", "dir", "directory", "pattern"]) || ".";
      break;
    }
    case "terminal":
      summary.subject = argString(tool.args, COMMAND_KEYS) || t("tool.runCommand");
      break;
    case "skill":
      summary.subject = argString(tool.args, ["skill", "name", "command"]) || friendlyName(tool.name);
      break;
    case "question": {
      const questions = asRecord(tool.args)?.questions;
      const firstQuestion = Array.isArray(questions) ? asRecord(questions[0])?.question : undefined;
      const first = typeof firstQuestion === "string" ? firstQuestion.trim() : "";
      summary.subject = first || t("tool.clarify");
      if (Array.isArray(questions) && questions.length > 1) summary.context = t("tool.questions", { count: questions.length });
      break;
    }
    case "todo": {
      const todos = todoItems(tool);
      const current = todos.find((item) => item.status === "in_progress") ?? todos.find((item) => item.status === "pending");
      const done = todos.filter((item) => item.status === "completed" || item.status === "cancelled").length;
      if (todos.length > 0) {
        const index = current ? todos.indexOf(current) + 1 : todos.length;
        summary.subject = `${index}/${todos.length}${current?.content ? ` · ${current.content}` : ""}`;
        summary.context = t("tool.todosDone", { done, total: todos.length });
      } else {
        summary.subject = t("tool.updateList");
      }
      break;
    }
    case "agent": {
      const roles = agentRoles(tool.args);
      summary.subject = roles.length > 0 ? compactRoles(roles) : t("tool.agent");
      if (roles.length > 1) summary.context = t("tool.tasks", { count: roles.length });
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
  group: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", marginVertical: 3 },
  row: { width: "100%", minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7 },
  icon: { width: 24, height: 24, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  label: { flexShrink: 0, fontSize: 13, fontWeight: "600" },
  subject: { flexShrink: 1, minWidth: 0, fontFamily: "monospace", fontSize: 12.5 },
  context: { flexShrink: 1, maxWidth: "28%", fontFamily: "monospace", fontSize: 11.5, opacity: 0.7 },
  spacer: { flex: 1, minWidth: 0 },
  error: { flexShrink: 0, fontSize: 12, fontWeight: "700" },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  detail: { paddingHorizontal: 10, paddingBottom: 10, gap: 6 },
  block: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  blockLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  blockText: { fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  noOutput: { fontSize: 12, paddingHorizontal: 2 },
});
