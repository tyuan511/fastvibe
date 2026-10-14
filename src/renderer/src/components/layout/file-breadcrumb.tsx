import { useCallback, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { PathMenuItems } from "@/components/path-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileIcon } from "@/components/file-icon";
import { cn } from "@/lib/utils";
import type { DirEntry } from "@shared/types";

/**
 * The open file's path, one segment per directory, each a popover of that folder's
 * contents.
 *
 * The tree beside it is for browsing; the breadcrumb is for moving *between* folders
 * once a file is open, which is the one thing a tree cannot do without collapsing what
 * the reader was looking at. A segment that is a directory opens a list; the file's own
 * name is the last segment and does not.
 *
 * The list is read on demand — the folder is fetched when the popover opens, not when
 * the path is drawn — so a deep path costs nothing until a segment is actually used.
 */

export type Crumb = { label: string; path: string; directory: boolean };

/**
 * Split a path into crumbs.
 *
 * `root` is the project directory: everything above it is not browsable (the home
 * directory, a volume) and is dropped, which keeps a long path from turning the header
 * into a wall of segments. A path outside the project keeps its own tail, so an opened
 * file is still named honestly.
 */
export function pathCrumbs(filePath: string, root?: string): Crumb[] {
  const normalise = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = normalise(filePath);
  const base = root === undefined ? "" : normalise(root);
  const relative = base !== "" && file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file.replace(/^\//, "");
  const parts = relative.split("/").filter((part) => part !== "");
  const crumbs: Crumb[] = [];
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    current = current === "" ? part : `${current}/${part}`;
    crumbs.push({ label: part, path: current, directory: index < parts.length - 1 });
  }
  return crumbs;
}

export function FileBreadcrumb({
  filePath,
  root,
  onOpenFile,
  onRevealInTree,
}: {
  filePath: string;
  root?: string;
  onOpenFile: (path: string) => void;
  onRevealInTree?: (path: string) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const crumbs = useMemo(() => pathCrumbs(filePath, root), [filePath, root]);
  const container = useRef<HTMLSpanElement>(null);

  /**
   * Arrow keys walk the segments, which is what the breadcrumb is for: a reader who
   * has just opened a nested file moves up a level without reaching for the mouse.
   */
  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const nodes = Array.from(container.current?.querySelectorAll<HTMLElement>("[data-crumb]") ?? []);
    const index = nodes.indexOf(event.target as HTMLElement);
    const next = nodes[event.key === "ArrowRight" ? index + 1 : index - 1];
    if (index < 0 || !next) return;
    event.preventDefault();
    next.focus();
  }

  return (
    <span
      ref={container}
      dir="ltr"
      className="chat-crumbs"
      onKeyDown={onKeyDown}
      aria-label={filePath}
      title={filePath}
    >
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="contents">
          {index > 0 ? <span aria-hidden className="chat-crumb-sep">/</span> : null}
          {crumb.directory ? (
            <CrumbPopover crumb={crumb} onOpenFile={onOpenFile} onRevealInTree={onRevealInTree} />
          ) : (
            // The file's own segment carries the same path menu a directory does — it is
            // the path the reader is most likely to want to copy or reveal.
            <ContextMenu>
              <ContextMenuTrigger
                render={<span data-crumb tabIndex={-1} className="chat-crumb is-file" />}
              >
                <FileIcon name={crumb.label} className="size-3.5" />
                <span className="truncate">{crumb.label}</span>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <PathMenuItems path={crumb.path} />
              </ContextMenuContent>
            </ContextMenu>
          )}
        </span>
      ))}
      {crumbs.length === 0 ? <span className="truncate">{filePath}</span> : null}
      <span className="sr-only">{t("files.pathSeparator")}</span>
    </span>
  );
}

function CrumbPopover({
  crumb,
  onOpenFile,
  onRevealInTree,
}: {
  crumb: Crumb;
  onOpenFile: (path: string) => void;
  onRevealInTree?: (path: string) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setEntries(await window.fastvibe.workspace.readDir(crumb.path));
      setFailed(false);
    } catch {
      setEntries([]);
      setFailed(true);
    }
  }, [crumb.path]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Read on open: a folder listing is a filesystem call, and a breadcrumb that
        // read every ancestor would cost one per segment for a path nobody asked about.
        if (next && entries === null) void load();
      }}
    >
      {/* Right-click is the same path menu the transcript uses — preview, reveal, copy —
          so a path acts the same wherever it is drawn. Left-click is what opens the
          folder listing, which is the one action the breadcrumb adds. */}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  data-crumb
                  className={cn("chat-crumb", open && "is-open")}
                  aria-label={t("files.filesIn", { folder: crumb.label })}
                />
              }
            />
          }
        >
          <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-3.5 shrink-0" />
          <span className="truncate">{crumb.label}</span>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {onRevealInTree ? (
            <button
              type="button"
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => onRevealInTree(crumb.path)}
            >
              {t("files.revealInTree")}
            </button>
          ) : null}
          <PathMenuItems path={crumb.path} />
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent align="start" className="w-72 gap-0 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <span className="truncate text-xs font-medium" title={crumb.path}>
            {t("files.filesIn", { folder: crumb.label })}
          </span>
          {onRevealInTree ? (
            <button
              type="button"
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                onRevealInTree(crumb.path);
                setOpen(false);
              }}
            >
              {t("files.revealInTree")}
            </button>
          ) : null}
        </div>
        {entries === null ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("files.listing")}</p>
        ) : failed ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("files.listFailed")}</p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("files.emptyFolder")}</p>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="p-1">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex h-7 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-xs hover:bg-muted"
                  title={entry.path}
                  onClick={() => {
                    setOpen(false);
                    onOpenFile(entry.path);
                  }}
                >
                  <FileIcon name={entry.name} kind={entry.kind === "directory" ? "folder" : "file"} />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
