import { memo, useEffect, useState, type JSX } from "react";
import {
  Check,
  ChevronRight,
  FileCode,
  FileSearch,
  FileText,
  Globe,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { ToolCallBlock } from "@shared/types";
import { useSessionStore } from "@/stores/session";
import { cn } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function argString(args: unknown, keys: string[]): string {
  const record = asRecord(args);
  if (!record) return typeof args === "string" ? args : "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function toolMeta(name: string): { label: string; icon: JSX.Element } {
  const key = name.toLowerCase();
  if (key.includes("bash") || key.includes("shell") || key === "command") {
    return { label: "命令", icon: <SquareTerminal className="size-3.5" /> };
  }
  if (key.includes("read")) return { label: "读取", icon: <FileText className="size-3.5" /> };
  if (key.includes("write") || key.includes("edit") || key.includes("apply")) {
    return { label: "编辑", icon: <FileCode className="size-3.5" /> };
  }
  if (key.includes("grep") || key.includes("search") || key.includes("glob")) {
    return { label: "搜索", icon: <FileSearch className="size-3.5" /> };
  }
  if (key.includes("web") || key.includes("fetch") || key.includes("browser")) {
    return { label: "网络", icon: <Globe className="size-3.5" /> };
  }
  if (key.includes("skill")) return { label: "技能", icon: <Sparkles className="size-3.5" /> };
  return { label: name, icon: <Wrench className="size-3.5" /> };
}

function formatToolBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function looksLikeDiff(text: string): boolean {
  const lines = text.split("\n");
  const marked = lines.filter((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("@@")).length;
  return marked >= 3;
}

function DiffView({ text }: { text: string }): JSX.Element {
  return (
    <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5 select-text">
      {text.split("\n").map((line, index) => (
        <div
          key={`${index}-${line.slice(0, 24)}`}
          className={
            line.startsWith("+")
              ? "text-emerald-700"
              : line.startsWith("-")
                ? "text-red-700"
                : line.startsWith("@@")
                  ? "text-sky-700"
                  : "text-muted-foreground"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** Memoised: unchanged tools keep their object identity, so finished cards skip
 *  re-rendering while the current turn streams. */
export const ToolCard = memo(function ToolCard({ tool }: { tool: ToolCallBlock }): JSX.Element {
  const running = tool.status === "running";
  const [open, setOpen] = useState(running);
  const meta = toolMeta(tool.name);
  const path = argString(tool.args, ["path", "file_path", "filename"]);
  const summary =
    argString(tool.args, ["command", "path", "file_path", "query", "pattern", "url", "skill", "name"]) || tool.name;
  const body = formatToolBody(tool.result?.trim() ?? "");
  const preview = body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body;
  const hasDetail = Boolean(preview || path);

  useEffect(() => {
    setOpen(running);
  }, [running]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <Spinner className="size-3" />
          ) : tool.status === "error" ? (
            <X className="size-3.5 text-destructive" />
          ) : (
            <Check className="size-3.5 text-emerald-700" />
          )}
        </span>
        {hasDetail ? (
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground">
            <span className="shrink-0 text-foreground/80">{meta.icon}</span>
            <span className="shrink-0 font-medium text-foreground">{meta.label}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px]">{summary}</span>
            <ChevronRight className={cn("ml-auto size-3 shrink-0 transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0 text-foreground/80">{meta.icon}</span>
            <span className="shrink-0 font-medium text-foreground">{meta.label}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px]">{summary}</span>
          </span>
        )}
      </div>
      {hasDetail ? (
        <CollapsibleContent>
          {path ? (
            <div className="mt-1 ml-6 flex flex-wrap gap-2">
              <button
                type="button"
                className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => void window.fastvibe.workspace.reveal(path)}
              >
                {path}
              </button>
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => void useSessionStore.getState().openPreview(path)}
              >
                预览
              </button>
            </div>
          ) : null}
          {preview ? (
            looksLikeDiff(preview) ? (
              <div className="ml-6">
                <DiffView text={preview} />
              </div>
            ) : (
              <pre className="mt-1.5 ml-6 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5 text-muted-foreground select-text">
                {preview}
              </pre>
            )
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
});
