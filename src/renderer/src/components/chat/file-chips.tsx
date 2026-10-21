import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { collectChangedFiles, type ChangedFile } from "@/lib/changed-files";
import { DiffStatBadge } from "@/components/chat/diff-stat";
import { useSidePaneStore } from "@/stores/side-pane";
import { useSessionStore, useWorkspacePath } from "@/stores/session";
import { FileIcon } from "@/components/file-icon";
import { displayProjectPath, projectFolderPaths } from "@shared/project-folders";
import { displayPath, resolvePath } from "@/lib/workspace-path";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export type { ChangedFile };
export { collectChangedFiles };


function fileLabel(path: string, cwd?: string): string {
  const { conversations, projects, activeId } = useSessionStore.getState();
  const bound = conversations.find((item) => item.id === activeId)?.project;
  const project = projects.find((item) => item.cwd === bound);
  const folders = project ? projectFolderPaths(project) : [];
  const shown = folders.length > 1 ? displayProjectPath(path, cwd, folders) : displayPath(path, cwd);
  return shown.replace(/\\/g, "/");
}

/**
 * `docs/release/v0.22.6.md` → name `v0.22.6.md`, directory `docs/release`.
 * The row leads with the name and draws the directory behind it in muted, the same
 * split the 变更 list uses: the name is what identifies the file, the rest only says
 * where it lives, and a path that has no directory keeps the whole label as the name.
 */
function splitLabel(label: string): { name: string; directory: string } {
  const index = label.lastIndexOf("/");
  return index < 0
    ? { name: label, directory: "" }
    : { name: label.slice(index + 1), directory: label.slice(0, index) };
}

function FileRow({
  file,
  cwd,
  onOpen,
}: {
  file: ChangedFile;
  cwd?: string;
  onOpen: (file: ChangedFile) => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const label = fileLabel(file.path, cwd);
  const { name, directory } = splitLabel(label);
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
            onClick={() => onOpen(file)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        }
      >
        <FileIcon name={name} />
        <span className="min-w-0 shrink truncate text-sm text-foreground" title={label}>{name}</span>
        {directory ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">{directory}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <DiffStatBadge added={file.added} removed={file.removed} />
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

/**
 * One turn's writes: one compact header line naming how many files changed and the
 * line totals, then the paths — five rows tall at most, the rest reached by scrolling
 * inside the card. A path (or 查看变更) opens the file in the 变更 view.
 *
 * A row used to answer a 300ms hover with its own diff popup — the turn's patch for that
 * file, in a `48rem` card that covered the reply while it was up. Two views of the same
 * change, one of them transient: a hover that opened it misread a pointer crossing the
 * list as a question, and the answer had to be dismissed before the transcript could be
 * read again. The card's job is to point at the change, so the click does the work.
 *
 * The header carries no glyph of its own — every row below it is already marked by
 * its file icon, so a leading 32px box only made the card taller than its content.
 * There is no 「再显示 N 个文件」 either: a fold that hid the tail behind a click while
 * the head still needed scrolling was two limits doing one job badly.
 */
export function TurnFileChips({ files, className }: { files: ChangedFile[]; className?: string }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(true);
  const cwd = useWorkspacePath();
  const openGitDiff = useSidePaneStore((state) => state.openGitDiff);
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  // The turn's chips are a pointer into the working tree, not a second diff view:
  // the file may already be staged, committed or reverted by a later turn, and the
  // 变更 view reads what is true now rather than what this turn wrote then.
  // The path goes out absolute — the tools reported it against this conversation's
  // cwd, while the 变更 list and its `git diff` resolve against the repository root,
  // which is not the same folder for a project bound to a subdirectory.
  const review = (path: string): void => openGitDiff(resolvePath(path, cwd), "unstaged", cwd);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("w-full overflow-hidden rounded-xl border border-border bg-muted/40", className)}
    >
      <div className={cn("flex items-center gap-2 px-3 py-1.5", open && "border-b border-border/60")}>
        <CollapsibleTrigger
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {/* Shrinks before the totals and the button do, so a narrow column clips the label rather than pushing them out. */}
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {t("files.edited", { count: files.length })}
          </span>
          <DiffStatBadge added={added} removed={removed} />
          <HugeiconsIcon
            strokeWidth={2}
            aria-hidden
            icon={ArrowRight01Icon}
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")}
          />
        </CollapsibleTrigger>
        <Button type="button" variant="outline" size="xs" className="shrink-0 rounded-full" onClick={() => review(files[0].path)}>
          {t("files.review")}
        </Button>
      </div>
      <CollapsibleContent>
        {/*
         * The box that scrolls is the full width of the card, and the inset lives on what
         * is inside it: a scrollbar is painted on the edge of the scrolling element's border
         * box, so the old `px-1.5` wrapper parked the bar 6px off the card's right edge — a
         * bar floating in the middle of the row ends rather than one hugging the frame. Every
         * row keeps its position (the bar still takes its 11px out of the content box) and the
         * bar lands against the edge. The gaps stay outside the scroller, or they would
         * be scrolled content and cut the fifth row of a five-file list.
         *
         * The top one is its own gap rather than the first row's `py-1.5`: that padding is the
         * air *between* rows, so with neither the header's rule sat directly on a row's top
         * edge — the list read as a table body under a header instead of as one card's fold,
         * and a hovered first row tinted hard against the rule.
         */}
        <div className="pt-1.5 pb-1.5">
          <div className="max-h-40 overflow-y-auto">
            <div className="px-1.5">
              {/*
               * Five rows of `py-1.5` + a `text-sm` line is 5 × 2rem, and the cap is in rem
               * so it follows 界面字号 like the rows themselves. The list scrolls instead of
               * growing: a turn that wrote forty files must not push its own reply off screen.
               */}
              {files.map((file) => (
                <FileRow key={file.path} file={file} cwd={cwd} onOpen={(changed) => review(changed.path)} />
              ))}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
