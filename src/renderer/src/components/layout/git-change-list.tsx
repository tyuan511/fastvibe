import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon, ArrowRight01Icon, Copy01Icon, Delete02Icon, File01Icon, GitCompareIcon, MinusSignIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { FileIcon } from "@/components/file-icon";
import { IconButton } from "@/components/icon-button";
import { buildGitChangeTree, flattenGitChangeTree, type GitTreeNode, type GitTreeRow } from "@/lib/git-change-tree";
import { displayPath, resolvePath } from "@/lib/workspace-path";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import { cn } from "@/lib/utils";
import type { GitDiffSource, GitStatus } from "@shared/ipc";

type File = GitStatus["files"][number];
export function isConflict(file: File): boolean {
  return file.index === "U" || file.worktree === "U" || ["AA", "DD"].includes(file.index + file.worktree);
}
const tones: Record<string, string> = {
  M: "text-warning", T: "text-warning", A: "text-success", "?": "text-success",
  D: "text-destructive", U: "text-destructive", R: "text-info", C: "text-info",
};
const labels: Record<string, string> = {
  M: "modified", T: "typeChange", A: "added", "?": "untracked", D: "deleted", U: "conflict", R: "renamed", C: "copied",
};

export function GitChangeList({ files, cwd, source, selected, tree, busy, label, onSelect, onStage, onUnstage, onDiscard }: {
  files: File[];
  cwd: string;
  source: GitDiffSource;
  selected?: string;
  tree: boolean;
  busy: boolean;
  label: string;
  onSelect: (file: File) => void;
  onStage?: (paths: string[]) => void;
  onUnstage?: (paths: string[]) => void;
  onDiscard?: (file: File) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string>();
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const nodes = useMemo(() => buildGitChangeTree(files, (file) => displayPath(file.path, cwd)), [files, cwd]);
  const rows = useMemo<GitTreeRow<File>[]>(() => tree
    ? flattenGitChangeTree(nodes, collapsed)
    : [...files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })).map((file, index) => {
      const path = displayPath(file.path, cwd);
      return { id: `file:${path}`, node: { kind: "file", name: path.split("/").pop() ?? path, path, file }, depth: 0, position: index + 1, siblings: files.length };
    }), [nodes, tree, collapsed, files, cwd]);
  const selectedId = selected ? `file:${displayPath(selected, cwd)}` : undefined;
  const tabId = rows.some((row) => row.id === focused) ? focused : rows.some((row) => row.id === selectedId) ? selectedId : rows[0]?.id;

  useEffect(() => {
    if (!selected) return;
    const path = displayPath(selected, cwd);
    setCollapsed((old) => new Set([...old].filter((dir) => !path.startsWith(`${dir}/`))));
    const frame = requestAnimationFrame(() => {
      rowElements.current.get(`file:${path}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, cwd]);

  function toggle(path: string, close?: boolean): void {
    setCollapsed((old) => {
      const next = new Set(old);
      if (close ?? !old.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  }
  function focusRow(id?: string): void {
    if (!id) return;
    setFocused(id);
    requestAnimationFrame(() => {
      const element = rowElements.current.get(id);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  function activate(node: GitTreeNode<File>): void {
    if (node.kind === "directory") toggle(node.path);
    else onSelect(node.file);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, row: GitTreeRow<File>, index: number): void {
    if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) return;
    const { node } = row;
    switch (event.key) {
      case "ArrowDown": focusRow(rows[Math.min(rows.length - 1, index + 1)]?.id); break;
      case "ArrowUp": focusRow(rows[Math.max(0, index - 1)]?.id); break;
      case "Home": focusRow(rows[0]?.id); break;
      case "End": focusRow(rows.at(-1)?.id); break;
      case "ArrowRight":
        if (node.kind === "directory") {
          if (collapsed.has(node.path)) toggle(node.path, false);
          else focusRow(rows[index + 1]?.id);
        }
        break;
      case "ArrowLeft":
        if (node.kind === "directory" && !collapsed.has(node.path)) toggle(node.path, true);
        else focusRow(row.parent);
        break;
      case "Enter": case " ": activate(node); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
  async function copyPath(path: string): Promise<void> {
    try { await navigator.clipboard.writeText(path); toast.success(t("files.pathCopied")); }
    catch { toast.error(t("resources.copyFailed")); }
  }
  async function openFile(file: File): Promise<void> {
    const conversation = useSessionStore.getState().activeId;
    try {
      const preview = await window.fastvibe.workspace.preview(resolvePath(file.path, cwd));
      if (mounted.current && conversation === useSessionStore.getState().activeId) useSidePaneStore.getState().openFilePreview(preview);
    } catch (error) {
      if (mounted.current) toast.error(error instanceof Error ? error.message : t("git.openFailed"));
    }
  }

  return (
    <div role="tree" aria-label={label} className="group/scm-tree min-w-0 py-0.5">
      {rows.map((row, index) => {
        const { node, depth } = row;
        const file = node.kind === "file" ? node.file : undefined;
        const directory = node.kind === "directory";
        const open = directory && !collapsed.has(node.path);
        const active = !!file && file.path === selected;
        const letter = file ? isConflict(file) ? "U" : source === "staged" ? file.index.trim() : file.index === "?" ? "?" : file.worktree.trim() || file.index.trim() : "";
        const status = file ? t(`git.${labels[letter] ?? "modified"}`) : "";
        const paths = directory ? node.files.map((item) => item.path) : [node.file.path];
        const slash = node.path.lastIndexOf("/");
        const parent = slash < 0 ? "" : node.path.slice(0, slash);
        const title = file ? `${node.path}\n${status}` : `${node.path} · ${paths.length}`;
        const stageLabel = directory ? t("git.stageFolder", { count: paths.length }) : t("git.stageFile", { path: node.name });
        const unstageLabel = directory ? t("git.unstageFolder", { count: paths.length }) : t("git.unstageFile", { path: node.name });
        return (
          <ContextMenu key={row.id}>
            <ContextMenuTrigger
              render={<div />}
              ref={(element) => { if (element) rowElements.current.set(row.id, element); else rowElements.current.delete(row.id); }}
              role="treeitem"
              aria-label={file ? `${node.name}, ${status}` : node.name}
              aria-level={depth + 1}
              aria-posinset={row.position}
              aria-setsize={row.siblings}
              aria-expanded={directory ? open : undefined}
              aria-selected={active}
              tabIndex={row.id === tabId ? 0 : -1}
              title={title}
              onFocus={() => setFocused(row.id)}
              onClick={() => activate(node)}
              onKeyDown={(event) => onKeyDown(event, row, index)}
              className={cn(
                "group/scm-row relative flex h-7 min-w-0 cursor-default items-center gap-1.5 border-l-2 border-l-transparent pr-2 text-xs outline-none select-none",
                "hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
                active && "border-l-primary bg-primary/10 text-foreground hover:bg-primary/15",
              )}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {depth ? <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex opacity-40 group-hover/scm-tree:opacity-100">{Array.from({ length: depth }, (_, i) => <span key={i} className="w-3.5 border-l border-border/70" />)}</span> : null}
              {tree ? <span aria-hidden className="flex w-3 shrink-0 items-center">{directory ? <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} strokeWidth={2} /> : null}</span> : null}
              <span className="flex size-4 shrink-0 items-center justify-center"><FileIcon name={directory ? node.name.split("/").pop()! : node.name} kind={directory ? "folder" : "file"} expanded={open} /></span>
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className={cn("min-w-0 truncate", directory ? "text-foreground/85" : "text-foreground", !directory && letter === "D" && "text-muted-foreground line-through decoration-muted-foreground/50")}>{node.name}</span>
                {!tree && parent ? <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">{parent}</span> : null}
              </div>
              {/* The action slot always has the same width; hover never shifts the filename. */}
              {onStage || onUnstage ? <div className="pointer-events-none flex w-6 shrink-0 items-center justify-end opacity-0 group-hover/scm-row:pointer-events-auto group-hover/scm-row:opacity-100 group-focus-within/scm-row:pointer-events-auto group-focus-within/scm-row:opacity-100" onClick={(event) => event.stopPropagation()}>
                <IconButton
                  size="icon-xs" variant="ghost" className="size-6 rounded-sm"
                  tabIndex={-1} label={onStage ? stageLabel : unstageLabel} disabled={busy}
                  onClick={() => (onStage ?? onUnstage)?.(paths)}
                ><HugeiconsIcon icon={onStage ? Add01Icon : MinusSignIcon} size={14} /></IconButton>
              </div> : null}
              <span className={cn("w-4 shrink-0 text-right font-mono text-[11px] tabular-nums", directory ? "text-muted-foreground/65" : tones[letter])} title={directory ? t("git.changedCount", { count: paths.length }) : status}>{directory ? paths.length : letter === "?" ? "U" : letter}</span>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-48">
              {file ? <>
                <ContextMenuItem onClick={() => onSelect(file)}><HugeiconsIcon icon={GitCompareIcon} />{t("git.reviewChanges")}</ContextMenuItem>
                <ContextMenuItem onClick={() => void openFile(file)}><HugeiconsIcon icon={File01Icon} />{t("git.openFile")}</ContextMenuItem>
                <ContextMenuSeparator />
              </> : null}
              {onStage ? <ContextMenuItem disabled={busy} onClick={() => onStage(paths)}><HugeiconsIcon icon={Add01Icon} />{directory ? stageLabel : t("git.stage")}</ContextMenuItem> : null}
              {onUnstage ? <ContextMenuItem disabled={busy} onClick={() => onUnstage(paths)}><HugeiconsIcon icon={MinusSignIcon} />{directory ? unstageLabel : t("git.unstage")}</ContextMenuItem> : null}
              {onDiscard && file && !isConflict(file) ? <ContextMenuItem variant="destructive" disabled={busy} onClick={() => onDiscard(file)}><HugeiconsIcon icon={Delete02Icon} />{t("git.discard")}</ContextMenuItem> : null}
              {onStage || onUnstage ? <ContextMenuSeparator /> : null}
              <ContextMenuItem onClick={() => void copyPath(node.path)}><HugeiconsIcon icon={Copy01Icon} />{t("git.copyRelativePath")}</ContextMenuItem>
              {directory ? <ContextMenuItem onClick={() => toggle(node.path)}>{t(open ? "git.collapseFolder" : "git.expandFolder")}</ContextMenuItem> : null}
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}

export function GitChangeGroup({ title, count, children, action, hidden }: { title: string; count: number; children: ReactNode; action?: ReactNode; hidden?: boolean }): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={hidden ? "hidden" : ""}>
      <div className="flex h-8 w-full items-center gap-1 border-b border-border/40 bg-muted px-2">
        <CollapsibleTrigger render={<Button variant="ghost" className="h-full min-w-0 flex-1 justify-start gap-1.5 rounded-none bg-transparent px-0 text-xs font-medium hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent" />}>
          <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3" />
          <span className="truncate">{title}</span>
          <span className="ml-auto min-w-5 rounded-full bg-foreground/7 px-1.5 py-0.5 text-center text-[10px] leading-none tabular-nums text-muted-foreground">{count}</span>
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
