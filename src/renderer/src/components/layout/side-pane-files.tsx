import { useCallback, useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Folder01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileIcon } from "@/components/file-icon";
import { PreviewBody } from "@/components/chat/preview-panel";
import { cn } from "@/lib/utils";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import type { DirEntry, FilePreview } from "@shared/types";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";

type DirMap = Record<string, DirEntry[]>;

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Directories between `cwd` and `filePath` that the tree must expand to reveal the file. */
function ancestorDirs(cwd: string, filePath: string): string[] {
  const dirs: string[] = [];
  let current = filePath;
  while (true) {
    const slash = current.lastIndexOf("/");
    if (slash <= 0) break;
    current = current.slice(0, slash);
    if (current.length < cwd.length || current === cwd) break;
    dirs.push(current);
  }
  return dirs;
}

/**
 * The right pane's project file view: a lazily-loaded directory tree of the
 * active workspace. Narrow panes swap between the tree and a file preview;
 * when the pane is wide enough the preview sits on the left and the tree stays
 * on the right. The preview is stored on the tab, so a chat click focuses the
 * same view.
 */
export function SidePaneFiles({
  tab,
  cwd,
  onError,
}: {
  tab: SidePaneTab;
  cwd?: string;
  onError: (message: string) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const [children, setChildren] = useState<DirMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDir = useCallback(async (path: string): Promise<void> => {
    try {
      const entries = await window.fastvibe.workspace.readDir(path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
    } catch {
      setChildren((prev) => ({ ...prev, [path]: [] }));
    }
  }, []);

  const reset = useCallback(
    (path: string | undefined): void => {
      setChildren({});
      setExpanded(new Set());
      if (path) void loadDir(path);
    },
    [loadDir],
  );

  useEffect(() => {
    reset(cwd);
  }, [cwd, reset]);

  useEffect(() => {
    const path = tab.path;
    if (!cwd || !path) return;
    const dirs = ancestorDirs(cwd, path);
    if (dirs.length === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const dir of dirs) {
        if (!next.has(dir)) {
          next.add(dir);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const dir of dirs) void loadDir(dir);
  }, [cwd, tab.path, loadDir]);

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!children[path]) void loadDir(path);
  }

  async function openFile(path: string): Promise<void> {
    try {
      const preview = await window.fastvibe.workspace.preview(path);
      patchTab(tab.id, { path, preview });
    } catch (error) {
      onError(error instanceof Error ? error.message : t("files.previewFailed"));
    }
  }

  function clearPreview(): void {
    patchTab(tab.id, { path: undefined, preview: undefined });
  }

  if (!cwd) {
    if (tab.preview) {
      return <FilePreviewPane preview={tab.preview} onBack={clearPreview} />;
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-xs leading-5 text-muted-foreground">
        {t("files.unbound")}
      </div>
    );
  }

  const preview = tab.preview;

  return (
    <div className="@container/files flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col @min-[32rem]/files:flex-row">
        {preview ? (
          <FilePreviewPane preview={preview} onBack={clearPreview} backClassName="@min-[32rem]/files:hidden" />
        ) : (
          <div className="hidden min-h-0 min-w-0 flex-1 items-center justify-center px-8 text-center text-xs leading-5 text-muted-foreground @min-[32rem]/files:flex">
            {t("files.pick")}
          </div>
        )}
        <div
          className={cn(
            "min-h-0 flex-col @min-[32rem]/files:w-[min(14rem,40%)] @min-[32rem]/files:min-w-36 @min-[32rem]/files:flex-none @min-[32rem]/files:border-l @min-[32rem]/files:border-border",
            preview ? "hidden @min-[32rem]/files:flex" : "flex flex-1",
          )}
        >
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
            <FileIcon name={baseName(cwd)} kind="folder" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={cwd}>
              {baseName(cwd)}
            </span>
            <IconButton
              size="icon-xs"
              variant="ghost"
              label={t("files.reveal")}
              onClick={() => {
                if (blockedRemotely(Ipc.workspaceReveal)) return;
                void window.fastvibe.workspace.reveal(cwd);
              }}
            >
              <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
            </IconButton>
            <IconButton size="icon-xs" variant="ghost" label={t("files.refresh")} onClick={() => reset(cwd)}>
              <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
            </IconButton>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="py-1.5">
              <TreeLevel
                dir={cwd}
                depth={0}
                children={children}
                expanded={expanded}
                selected={preview?.path}
                onToggle={toggleDir}
                onOpen={openFile}
              />
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function FilePreviewPane({
  preview,
  onBack,
  backClassName,
}: {
  preview: FilePreview;
  onBack: () => void;
  backClassName?: string;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <IconButton
          size="icon-xs"
          variant="ghost"
          label={t("files.back")}
          className={backClassName}
          onClick={onBack}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
        </IconButton>
        <FileIcon name={baseName(preview.path)} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={preview.path}>
          {preview.name}
        </span>
        {preview.kind !== "error" ? (
          <IconButton
            size="icon-xs"
            variant="ghost"
            label={t("files.reveal")}
            onClick={() => {
              if (blockedRemotely(Ipc.workspaceReveal)) return;
              void window.fastvibe.workspace.reveal(preview.path);
            }}
          >
            <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
          </IconButton>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <PreviewBody preview={preview} />
      </ScrollArea>
    </div>
  );
}

function TreeLevel({
  dir,
  depth,
  children,
  expanded,
  selected,
  onToggle,
  onOpen,
}: {
  dir: string;
  depth: number;
  children: DirMap;
  expanded: Set<string>;
  selected?: string;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}): JSX.Element {
  const entries = children[dir] ?? [];
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.kind === "directory";
        const open = isDir && expanded.has(entry.path);
        const active = !isDir && selected === entry.path;
        return (
          <div key={entry.path}>
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex h-7 w-full items-center gap-1.5 pr-2 text-left text-xs text-foreground transition-colors hover:bg-muted",
                active && "bg-muted",
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              title={entry.path}
              onClick={() => (isDir ? onToggle(entry.path) : onOpen(entry.path))}
            >
              <FileIcon name={entry.name} kind={isDir ? "folder" : "file"} expanded={open} />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {open ? (
              <TreeLevel
                dir={entry.path}
                depth={depth + 1}
                children={children}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
