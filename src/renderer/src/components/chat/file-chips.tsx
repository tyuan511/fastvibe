import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/file-icon";
import { collectChangedFiles, type ChangedFile } from "@/lib/changed-files";
import { useSidePaneStore } from "@/stores/side-pane";

export type { ChangedFile };
export { collectChangedFiles };

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function FileChip({ file, onOpen }: { file: ChangedFile; onOpen: (file: ChangedFile) => void }): JSX.Element {
  const name = fileName(file.path);
  return (
    <button
      type="button"
      // Purely an affordance for the *first* click: the chip adds nothing the tool card
      // does not already show, but 「which of these 12 files was it」 is the question the
      // chip exists to answer, and opening its diff is the answer.
      title={file.path}
      onClick={() => onOpen(file)}
      className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-border bg-muted/40 pr-2 pl-1.5 text-xs transition-colors hover:border-ring hover:bg-muted"
    >
      <FileIcon name={name} />
      <span className="min-w-0 truncate text-foreground">{name}</span>
      {file.added > 0 ? <span className="shrink-0 tabular-nums text-success">+{file.added}</span> : null}
      {file.removed > 0 ? <span className="shrink-0 tabular-nums text-destructive">-{file.removed}</span> : null}
    </button>
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
            // The chip is the only way into 本轮修改: the pane itself has no 打开
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
