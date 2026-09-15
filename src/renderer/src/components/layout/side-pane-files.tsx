import { useCallback, useEffect, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Folder01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileIcon } from "@/components/file-icon";
import { PreviewBody } from "@/components/chat/preview-panel";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import type { DirEntry } from "@shared/types";

type DirMap = Record<string, DirEntry[]>;

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * The right pane's project file view: a lazily-loaded directory tree of the
 * active workspace by default, swapping to a file preview once a file is picked
 * (here or from a chat file chip). The preview is stored on the tab, so a chat
 * click focuses the same view.
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
      onError(error instanceof Error ? error.message : "无法预览该文件");
    }
  }

  if (tab.preview) {
    const preview = tab.preview;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <IconButton
            size="icon-xs"
            variant="ghost"
            label="返回目录树"
            onClick={() => patchTab(tab.id, { path: undefined, preview: undefined })}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
          </IconButton>
          <FileIcon name={baseName(preview.path)} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={preview.path}>
            {preview.name}
          </span>
          {preview.kind !== "error" ? (
            <IconButton
              size="icon-xs"
              variant="ghost"
              label="在访达中显示"
              onClick={() => void window.fastvibe.workspace.reveal(preview.path)}
            >
              <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
            </IconButton>
          ) : null}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-3">
            <PreviewBody preview={preview} />
          </div>
        </ScrollArea>
      </div>
    );
  }

  if (!cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-[12.5px] leading-5 text-muted-foreground">
        当前对话未绑定项目，绑定项目后即可浏览文件。
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <FileIcon name={baseName(cwd)} kind="folder" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={cwd}>
          {baseName(cwd)}
        </span>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="在访达中显示"
          onClick={() => void window.fastvibe.workspace.reveal(cwd)}
        >
          <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
        </IconButton>
        <IconButton size="icon-xs" variant="ghost" label="刷新" onClick={() => reset(cwd)}>
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
            onToggle={toggleDir}
            onOpen={openFile}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

function TreeLevel({
  dir,
  depth,
  children,
  expanded,
  onToggle,
  onOpen,
}: {
  dir: string;
  depth: number;
  children: DirMap;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}): JSX.Element {
  const entries = children[dir] ?? [];
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.kind === "directory";
        const open = isDir && expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[12.5px] text-foreground transition-colors hover:bg-muted"
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
