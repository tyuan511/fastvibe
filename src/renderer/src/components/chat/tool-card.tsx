import type { JSX } from "react";
import {
  Check,
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
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import type { ToolCallBlock } from "@shared/types";
import { useSessionStore } from "@/stores/session";

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
    return { label: "命令", icon: <SquareTerminal /> };
  }
  if (key.includes("read")) return { label: "读取", icon: <FileText /> };
  if (key.includes("write") || key.includes("edit") || key.includes("apply")) {
    return { label: "编辑", icon: <FileCode /> };
  }
  if (key.includes("grep") || key.includes("search") || key.includes("glob")) {
    return { label: "搜索", icon: <FileSearch /> };
  }
  if (key.includes("web") || key.includes("fetch") || key.includes("browser")) {
    return { label: "网络", icon: <Globe /> };
  }
  if (key.includes("skill")) return { label: "技能", icon: <Sparkles /> };
  return { label: name, icon: <Wrench /> };
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
    <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5">
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

export function ToolCard({ tool }: { tool: ToolCallBlock }): JSX.Element {
  const meta = toolMeta(tool.name);
  const path = argString(tool.args, ["path", "file_path", "filename"]);
  const summary =
    argString(tool.args, ["command", "path", "file_path", "query", "pattern", "url", "skill", "name"]) ||
    tool.name;
  const body = formatToolBody(tool.result?.trim() ?? "");
  const preview = body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body;

  return (
    <Collapsible defaultOpen={tool.status === "running"}>
      <Item variant="outline" size="xs" className="items-start">
        <ItemMedia variant="icon">
          {tool.status === "running" ? (
            <Spinner />
          ) : tool.status === "error" ? (
            <X />
          ) : (
            <Check />
          )}
        </ItemMedia>
        <ItemContent>
          <CollapsibleTrigger className="w-full text-left">
            <ItemTitle className="gap-1.5">
              {meta.icon}
              <span className="truncate">{meta.label}</span>
              <span className="truncate font-normal text-muted-foreground">{summary}</span>
            </ItemTitle>
            {!body ? <ItemDescription className="font-mono">{summary}</ItemDescription> : null}
          </CollapsibleTrigger>
          {path ? (
            <div className="mt-1 flex flex-wrap gap-2">
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
            <CollapsibleContent>
              {looksLikeDiff(preview) ? (
                <DiffView text={preview} />
              ) : (
                <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                  {preview}
                </pre>
              )}
            </CollapsibleContent>
          ) : null}
        </ItemContent>
      </Item>
    </Collapsible>
  );
}
