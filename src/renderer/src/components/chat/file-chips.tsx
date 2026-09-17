import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/file-icon";
import type { ToolCallBlock } from "@shared/types";

/** A file touched by one agent turn, with the lines it added and removed. */
export type ChangedFile = { path: string; added: number; removed: number };

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Count `+` / `-` lines of a unified patch, ignoring the file headers. */
function countPatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function countContent(content: string): number {
  return content ? content.replace(/\n$/, "").split("\n").length : 0;
}

/**
 * Collect the files an assistant run wrote, from its `edit` patches and `write`
 * contents. `edit` carries a unified patch in `details`; `write` only carries the
 * new content, which counts as additions.
 */
export function collectChangedFiles(tools: ToolCallBlock[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const add = (path: string, added: number, removed: number): void => {
    if (!path) return;
    const entry = files.get(path) ?? { path, added: 0, removed: 0 };
    entry.added += added;
    entry.removed += removed;
    files.set(path, entry);
  };
  for (const tool of tools) {
    if (tool.status !== "done") continue;
    const args = tool.args && typeof tool.args === "object" ? (tool.args as { path?: unknown; content?: unknown }) : {};
    const path = typeof args.path === "string" ? args.path : "";
    if (tool.name === "edit") {
      const details =
        tool.details && typeof tool.details === "object" ? (tool.details as { patch?: unknown }) : {};
      if (typeof details.patch === "string") {
        const { added, removed } = countPatch(details.patch);
        add(path, added, removed);
      }
    } else if (tool.name === "write") {
      add(path, countContent(typeof args.content === "string" ? args.content : ""), 0);
    }
  }
  return [...files.values()];
}

function FileChip({ file }: { file: ChangedFile }): JSX.Element {
  const name = fileName(file.path);
  return (
    <span className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-border bg-muted/40 pr-2 pl-1.5 text-xs">
      <FileIcon name={name} />
      <span title={file.path} className="min-w-0 truncate text-foreground">
        {name}
      </span>
      {file.added > 0 ? <span className="shrink-0 tabular-nums text-success">+{file.added}</span> : null}
      {file.removed > 0 ? <span className="shrink-0 tabular-nums text-destructive">-{file.removed}</span> : null}
    </span>
  );
}

/** The turn's changed files as chips, collapsed to one row past six files. */
export function TurnFileChips({ files, className }: { files: ChangedFile[]; className?: string }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  const collapsible = files.length > 6;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", collapsible && !open && "max-h-7 overflow-hidden")}>
        {files.map((file) => (
          <FileChip key={file.path} file={file} />
        ))}
      </div>
      {collapsible ? (
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("files.collapse") : t("files.expand", { count: files.length })}
        </button>
      ) : null}
    </div>
  );
}
