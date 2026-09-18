import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, FileEditIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DiffView } from "@/components/chat/diff-view";
import { FileIcon } from "@/components/file-icon";
import { IconButton } from "@/components/icon-button";
import type { ChangedFile } from "@/lib/changed-files";
import { displayPath, resolvePath } from "@/lib/workspace-path";
import { cn } from "@/lib/utils";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";

function splitRelPath(path: string, cwd?: string): { name: string; dir: string } {
  const rel = displayPath(path, cwd).replace(/\\/g, "/");
  const slash = rel.lastIndexOf("/");
  if (slash < 0) return { name: rel, dir: "" };
  return { name: rel.slice(slash + 1), dir: rel.slice(0, slash) };
}

/**
 * One turn's writes, opened from the transcript's file chips — never from the
 * pane's own 打开标签页 / 新增标签 menus. The diffs are the tools' own patches,
 * not `git diff HEAD`, so an older turn still shows what *it* changed.
 */
export function SidePaneChanges({
  cwd,
  files,
  path,
  onSelect,
}: {
  cwd?: string;
  files: ChangedFile[];
  path?: string;
  onSelect: (path: string | undefined) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const selected = useMemo(() => files.find((file) => file.path === path), [files, path]);

  return (
    <div className="@container/changes flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col @min-[32rem]/changes:flex-row">
        <div
          className={cn(
            "min-h-0 flex-col @min-[32rem]/changes:w-[min(16rem,40%)] @min-[32rem]/changes:min-w-40 @min-[32rem]/changes:flex-none @min-[32rem]/changes:border-r @min-[32rem]/changes:border-border",
            selected ? "hidden @min-[32rem]/changes:flex" : "flex flex-1",
          )}
        >
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
            <HugeiconsIcon strokeWidth={2} icon={FileEditIcon} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {t("changes.count", { count: files.length })}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-1 py-1.5">
              {files.length ? (
                files.map((file) => {
                  const { name, dir } = splitRelPath(file.path, cwd);
                  const active = selected?.path === file.path;
                  return (
                    <button
                      type="button"
                      key={file.path}
                      aria-current={active ? "true" : undefined}
                      title={file.path}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                        active && "bg-muted",
                      )}
                      onClick={() => onSelect(file.path)}
                    >
                      <FileIcon name={name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-foreground">{name}</span>
                        {dir ? <span className="block truncate text-xs text-muted-foreground">{dir}</span> : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums">
                        {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
                        {file.removed > 0 ? <span className="text-destructive">−{file.removed}</span> : null}
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="px-2 py-10 text-center text-xs leading-5 text-muted-foreground">{t("changes.empty")}</p>
              )}
            </div>
          </ScrollArea>
        </div>

        {selected ? (
          <ChangeDiffPane cwd={cwd} file={selected} onBack={() => onSelect(undefined)} />
        ) : (
          <div className="hidden min-h-0 min-w-0 flex-1 items-center justify-center px-8 text-center text-xs leading-5 text-muted-foreground @min-[32rem]/changes:flex">
            {t("changes.pick")}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeDiffPane({
  cwd,
  file,
  onBack,
}: {
  cwd?: string;
  file: ChangedFile;
  onBack: () => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const { name } = splitRelPath(file.path, cwd);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <IconButton
          size="icon-xs"
          variant="ghost"
          label={t("changes.back")}
          className="@min-[32rem]/changes:hidden"
          onClick={onBack}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
        </IconButton>
        <FileIcon name={name} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={file.path}>
          {name}
        </span>
        {file.added > 0 ? <span className="shrink-0 text-xs tabular-nums text-success">+{file.added}</span> : null}
        {file.removed > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-destructive">−{file.removed}</span>
        ) : null}
        <IconButton
          size="icon-xs"
          variant="ghost"
          label={t("changes.reveal")}
          onClick={() => {
            if (blockedRemotely(Ipc.workspaceReveal)) return;
            void window.fastvibe.workspace.reveal(resolvePath(file.path, cwd));
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {file.diff ? (
          <DiffView text={file.diff} className="mt-0 max-h-none overflow-visible rounded-none border-0" />
        ) : (
          <p className="px-4 py-10 text-center text-xs leading-5 text-muted-foreground">{t("changes.noDiff")}</p>
        )}
      </ScrollArea>
    </div>
  );
}
