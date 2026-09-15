import { memo, type JSX } from "react";
import { Spinner } from "@/components/ui/spinner";
import type { ToolCallBlock } from "@shared/types";
import { useSessionStore } from "@/stores/session";
import { asRecord, argString, describeTool, familyOf, unwrapShellCommand } from "@/lib/tool-presentation";
import { displayPath, useWorkspacePath } from "@/lib/workspace-path";
import { parseToolTodos } from "@/lib/todos";
import { DiffView } from "./diff-view";
import { QuestionAnswers } from "./question-answers";
import { TodoChecklist } from "./todo-list";
import { ToolRow } from "./tool-row";

const RESULT_LIMIT = 4000;

/** Tools that render as a single line whose subject opens the viewer (zcode: read/search/list). */
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
        <p className="font-mono text-sm text-muted-foreground">没有输出。</p>
      ) : null}
    </div>
  );
}

function OutputBlock({ text }: { text: string }): JSX.Element {
  const body = trim(text);
  if (!body) return <p className="text-sm text-muted-foreground">没有输出。</p>;
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-sm leading-5 text-muted-foreground select-text">
      {body}
    </pre>
  );
}

function Parameters({ args }: { args: unknown }): JSX.Element | null {
  if (args === undefined || args === null) return null;
  const text = asText(args).trim();
  if (!text || text === "{}") return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">参数</p>
      <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-sm leading-5 text-muted-foreground select-text">
        {trim(text)}
      </pre>
    </div>
  );
}

function FileActions({ path }: { path: string }): JSX.Element {
  const cwd = useWorkspacePath();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="font-mono text-sm text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => void window.fastvibe.workspace.reveal(path)}
      >
        {displayPath(path, cwd)}
      </button>
      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => void useSessionStore.getState().openPreview(path)}
      >
        预览
      </button>
    </div>
  );
}

function ToolDetail({ tool, running }: { tool: ToolCallBlock; running: boolean }): JSX.Element {
  const cwd = useWorkspacePath();
  const view = describeTool(tool, cwd);
  const path = argString(tool.args, FILE_PATH_KEYS);
  const diff = diffText(tool);

  if (view.family === "question") return <QuestionAnswers tool={tool} running={running} />;

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
    Boolean(tool.result?.length) ||
    Boolean(diffText(tool)) ||
    (tool.args !== undefined && !inline);

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
      onSubjectClick={
        view.family === "read" && path ? () => void useSessionStore.getState().openPreview(path) : undefined
      }
    >
      {hasDetail ? <ToolDetail tool={tool} running={running} /> : null}
    </ToolRow>
  );
});
