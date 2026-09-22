import { memo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { subagentStatusText } from "@/lib/subagent-status";
import { subagentResultStatus } from "@shared/subagent-state";
import { Spinner } from "@/components/ui/spinner";
import type { ToolCallBlock } from "@shared/types";
import { useSessionStore, useWorkspacePath } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import { asRecord, argString, describeTool, familyOf, unwrapShellCommand } from "@/lib/tool-presentation";
import { displayPath, resolvePath } from "@/lib/workspace-path";
import { parseToolTodos } from "@/lib/todos";
import { DiffView } from "./diff-view";
import { MarkdownView } from "./markdown-view";
import { QuestionAnswers } from "./question-answers";
import { TodoChecklist } from "./todo-list";
import { ToolRow } from "./tool-row";
import { isRemoteRef } from "@/lib/remote-project";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";

const RESULT_LIMIT = 4000;

/** Tools that render as a single line whose subject opens the viewer (zcode: read/search/list).
 *  `web_search` is not in this set: its result (summary + sources) is the card body. */
const INLINE_FAMILIES = new Set(["read", "search", "list"]);

const FILE_PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "target"];

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : asRecord(part)?.text))
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  const record = asRecord(value);
  if (typeof record?.text === "string") return record.text;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

/** Prefer the engine's structured diff; fall back to a diff-shaped result body. */
function diffText(tool: ToolCallBlock): string | undefined {
  const details = asRecord(tool.details);
  if (typeof details?.diff === "string" && details.diff.trim()) return details.diff;
  const result = tool.result ?? "";
  const marked = result.split("\n").filter((line) => /^[+-]/.test(line)).length;
  return marked >= 3 ? result : undefined;
}

function trim(text: string): string {
  const body = text.trim();
  return body.length > RESULT_LIMIT ? `${body.slice(0, RESULT_LIMIT)}\n…` : body;
}

/** Terminal output panel: `$ command` header, then stdout (zcode's `nG` layout). */
function TerminalPanel({ command, output, running }: { command: string; output: string; running: boolean }): JSX.Element {
  const { t } = useTranslation("chat");
  return (
    <div className="mb-1 space-y-3 rounded-xl border border-border bg-muted/30 px-4 py-3">
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-muted-foreground">$</span>
        <pre className="min-w-0 flex-1 truncate font-mono text-sm whitespace-pre-wrap break-words text-foreground">
          {unwrapShellCommand(command)}
        </pre>
      </div>
      {output.trim() ? (
        <pre className="max-h-72 overflow-auto font-mono text-sm leading-5 whitespace-pre-wrap break-words text-muted-foreground select-text">
          {trim(output)}
        </pre>
      ) : !running ? (
        <p className="font-mono text-sm text-muted-foreground">{t("tools.noOutput")}</p>
      ) : null}
    </div>
  );
}

type WebSource = { title: string; url: string };

function webSources(tool: ToolCallBlock): WebSource[] {
  const list = asRecord(tool.details)?.sources;
  if (!Array.isArray(list)) return [];
  const sources: WebSource[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const row = asRecord(item);
    const url = typeof row?.url === "string" ? row.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof row?.title === "string" && row.title.trim() ? row.title.trim() : url;
    sources.push({ title, url });
  }
  return sources;
}

/** `web-search.ts` appends a `## 来源` markdown block; drop it when sources render separately. */
function webResultBody(text: string, hasSources: boolean): string {
  const body = text.trim();
  if (!hasSources) return body;
  return body.replace(/\n+## (?:来源|Sources)\n[\s\S]*$/, "").trim();
}

function WebSearchPanel({ tool, running }: { tool: ToolCallBlock; running: boolean }): JSX.Element {
  const { t } = useTranslation("chat");
  const sources = webSources(tool);
  const body = webResultBody(tool.result ?? "", sources.length > 0);
  if (!body && sources.length === 0) {
    return <p className="text-sm text-muted-foreground">{running ? t("tools.searching") : t("tools.noOutput")}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {body ? (
        <div className="max-h-72 overflow-auto text-sm leading-5 text-muted-foreground [&_a]:text-foreground [&_a]:underline-offset-2 hover:[&_a]:underline">
          <MarkdownView text={body} />
        </div>
      ) : null}
      {sources.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">{t("tools.sources")}</p>
          <ul className="flex flex-col gap-1">
            {sources.map((source) => (
              <li key={source.url} className="min-w-0">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  title={source.url}
                  className="block truncate text-sm text-foreground underline-offset-2 hover:underline"
                >
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function OutputBlock({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation("chat");
  const body = trim(text);
  if (!body) return <p className="text-sm text-muted-foreground">{t("tools.noOutput")}</p>;
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-sm leading-5 text-muted-foreground select-text">
      {body}
    </pre>
  );
}

function Parameters({ args }: { args: unknown }): JSX.Element | null {
  const { t } = useTranslation("chat");
  if (args === undefined || args === null) return null;
  const text = asText(args).trim();
  if (!text || text === "{}") return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">{t("tools.params")}</p>
      <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-sm leading-5 text-muted-foreground select-text">
        {trim(text)}
      </pre>
    </div>
  );
}

function FileActions({ path }: { path: string }): JSX.Element {
  const { t } = useTranslation("chat");
  const cwd = useWorkspacePath();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="font-mono text-sm text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => {
          const resolved = resolvePath(path, cwd);
          if (isRemoteRef(resolved) || isRemoteRef(cwd) || blockedRemotely(Ipc.workspaceReveal)) return;
          void window.fastvibe.workspace.reveal(resolved);
        }}
      >
        {displayPath(path, cwd)}
      </button>
      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => void useSessionStore.getState().openPreview(path)}
      >
        {t("tools.preview")}
      </button>
    </div>
  );
}

type SubagentEntry = { agent: string; task?: string };

/** Flatten any of the three subagent modes into the runs the host will spawn. */
function subagentEntries(args: unknown): SubagentEntry[] {
  const record = asRecord(args);
  if (!record) return [];
  const entries: SubagentEntry[] = [];
  if (typeof record.agent === "string")
    entries.push({ agent: record.agent, task: typeof record.task === "string" ? record.task : undefined });
  for (const key of ["tasks", "chain"]) {
    if (!Array.isArray(record[key])) continue;
    for (const item of record[key] as unknown[]) {
      const entry = asRecord(item);
      if (typeof entry?.agent === "string")
        entries.push({ agent: entry.agent, task: typeof entry.task === "string" ? entry.task : undefined });
    }
  }
  return entries;
}

function SubagentSummary({ tool }: { tool: ToolCallBlock }): JSX.Element {
  useTranslation("sidepane");
  const subagents = useSessionStore((state) => state.subagents);
  const counts = new Map<string, number>();
  subagentEntries(tool.args).forEach((_, index) => {
    const info = subagents.find((item) => item.id === `${tool.id}:${index}`);
    const label = subagentStatusText(info, subagentResultStatus(tool, index));
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  return <span className="text-xs text-muted-foreground">{[...counts].map(([label, count]) => `${label} ${count}`).join(" · ")}</span>;
}

/**
 * A delegated role is not a parameter list to inspect — it is a conversation. So
 * instead of dumping the tool's raw JSON, show one row per spawned run. The whole
 * row opens that run's own read-only tab in the right pane; status trails the row
 * (no button, no chevron) so the eye lands on the brief.
 */
function SubagentPanel({ tool }: { tool: ToolCallBlock }): JSX.Element {
  useTranslation("sidepane");
  const subagents = useSessionStore((state) => state.subagents);
  const openSubagent = useSidePaneStore((state) => state.openSubagent);
  const entries = subagentEntries(tool.args);

  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry, index) => {
        const id = `${tool.id}:${index}`;
        const state = subagents.find((item) => item.id === id);
        const fallback = subagentResultStatus(tool, index);
        const status = subagentStatusText(state, fallback);
        return (
          <button
            key={id}
            type="button"
            className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left hover:bg-muted/50"
            onClick={() =>
              openSubagent(id, {
                conversationId: state?.conversationId,
                title: entry.agent,
                status: state?.status ?? fallback,
                brief: entry.task ?? state?.detail,
              })
            }
          >
            <span className="shrink-0 font-mono text-sm text-foreground">{entry.agent}</span>
            {entry.task ? (
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{entry.task}</span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            {status ? <span className="shrink-0 text-xs text-muted-foreground">{status}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function ToolDetail({ tool, running }: { tool: ToolCallBlock; running: boolean }): JSX.Element {
  const cwd = useWorkspacePath();
  const view = describeTool(tool, cwd);
  const path = argString(tool.args, FILE_PATH_KEYS);
  const diff = diffText(tool);

  if (view.family === "question") return <QuestionAnswers tool={tool} running={running} />;

  if (view.family === "web") return <WebSearchPanel tool={tool} running={running} />;

  if (view.family === "agent") return <SubagentPanel tool={tool} />;

  if (view.family === "todo") {
    const todos = parseToolTodos(tool);
    if (todos.length > 0) return <TodoChecklist items={todos} />;
  }

  if (view.family === "terminal") {
    const command = argString(tool.args, ["command", "cmd", "script", "parsed_cmd"]) || tool.name;
    return <TerminalPanel command={command} output={tool.result ?? ""} running={running} />;
  }

  if (diff) {
    return (
      <div className="flex flex-col gap-2">
        {path ? <FileActions path={path} /> : null}
        <DiffView text={diff} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {path ? <FileActions path={path} /> : null}
      <Parameters args={tool.args} />
      {tool.result !== undefined ? <OutputBlock text={tool.result} /> : null}
    </div>
  );
}

/** Memoised: unchanged tools keep their object identity, so finished rows skip
 *  re-rendering while the current turn streams. */
export const ToolCard = memo(function ToolCard({
  tool,
  showIcon = true,
}: {
  tool: ToolCallBlock;
  showIcon?: boolean;
}): JSX.Element {
  const cwd = useWorkspacePath();
  const view = describeTool(tool, cwd);
  const running = tool.status === "running";
  // read / search / list are single-line rows in zcode: the subject opens the file
  // viewer instead of expanding an inline body.
  const inline = INLINE_FAMILIES.has(familyOf(tool.name));
  const path = argString(tool.args, FILE_PATH_KEYS);
  const hasDetail =
    view.family === "terminal" ||
    view.family === "todo" ||
    view.family === "question" ||
    view.family === "web" ||
    view.family === "agent" ||
    Boolean(tool.result?.length) ||
    Boolean(diffText(tool)) ||
    (tool.args !== undefined && !inline);
  // A subagent tool row expands into its runs; each row in that panel is itself
  // the doorway to that run's tab (see SubagentPanel).
  return (
    <ToolRow
      icon={running ? <Spinner className="size-3" /> : view.icon}
      label={view.label}
      subject={view.subject}
      context={view.context}
      error={tool.status === "error" ? tool.result ?? view.statusLabel : undefined}
      running={running}
      title={view.title}
      canToggle={!inline}
      showIcon={showIcon}
      persistKey={tool.id}
      trailing={view.family === "agent" ? <SubagentSummary tool={tool} /> : undefined}
      onSubjectClick={
        view.family === "read" && path ? () => void useSessionStore.getState().openPreview(path) : undefined
      }
    >
      {hasDetail ? <ToolDetail tool={tool} running={running} /> : null}
    </ToolRow>
  );
});
