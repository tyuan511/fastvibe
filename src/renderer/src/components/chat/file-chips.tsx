import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/file-icon";
import { collectChangedFiles, type ChangedFile } from "@/lib/changed-files";
import { useSidePaneStore } from "@/stores/side-pane";
import { useSessionStore } from "@/stores/session";
import { resolvePath } from "@/lib/workspace-path";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export type { ChangedFile };
export { collectChangedFiles };

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function FileChip({ file, onOpen }: { file: ChangedFile; onOpen: (file: ChangedFile) => void }): JSX.Element {
  const { t } = useTranslation("chat");
  const name = fileName(file.path);
  // The chip's own click opens the turn's diff; the menu is for the other questions one
  // asks of a file — see it as it is now, find it on disk, take its path elsewhere.
  const absolute = (): string => {
    const { conversations, activeId } = useSessionStore.getState();
    return resolvePath(file.path, conversations.find((item) => item.id === activeId)?.cwd);
  };
  const reveal = async (): Promise<void> => {
    const result = await window.fastvibe.workspace.reveal(absolute());
    if (result && result.ok === false) toast.error(t("preview.pathMissing"));
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            // Purely an affordance for the *first* click: the chip adds nothing the tool card
            // does not already show, but 「which of these 12 files was it」 is the question the
            // chip exists to answer, and opening its diff is the answer.
            title={file.path}
            onClick={() => onOpen(file)}
            className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-border bg-muted/40 pr-2 pl-1.5 text-xs transition-colors hover:border-ring hover:bg-muted"
          />
        }
      >
        <FileIcon name={name} />
        <span className="min-w-0 truncate text-foreground">{name}</span>
        {file.added > 0 ? <span className="shrink-0 tabular-nums text-success">+{file.added}</span> : null}
        {file.removed > 0 ? <span className="shrink-0 tabular-nums text-destructive">-{file.removed}</span> : null}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => void useSessionStore.getState().openPreview(absolute())}>
          {t("preview.pathPreview")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void reveal()}>{t("preview.pathReveal")}</ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(absolute())}>
          {t("preview.pathCopy")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The turn's changed files as chips, collapsed to one row past six files. */
export function TurnFileChips({ files, className }: { files: ChangedFile[]; className?: string }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const openTurnChanges = useSidePaneStore((state) => state.openTurnChanges);
  if (files.length === 0) return null;
  const collapsible = files.length > 6;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", collapsible && !open && "max-h-7 overflow-hidden")}>
        {files.map((file) => (
          <FileChip
            key={file.path}
            file={file}
            // The chip is the only way into 修改记录: the pane itself has no 打开
            // entry, and 审查's git diff is a different question (working tree vs HEAD).
            onOpen={(changed) => openTurnChanges(files, changed.path)}
          />
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
