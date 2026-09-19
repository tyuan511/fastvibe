import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  GitBranchIcon,
  MagicWand02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/icon-button";
import { useGitStatus } from "@/lib/use-git-status";
import { useSidePaneStore } from "@/stores/side-pane";
import type { GitStatus } from "@shared/ipc";

type BusyAction = "generate" | "commit" | "commit-push" | "pull" | "push";

/**
 * Persistent, lightweight repository status for the conversation header.
 * Detailed file review stays in the right pane; this popover only hosts the
 * small operations that are useful without leaving the conversation.
 */
export function GitStatusPopover({
  cwd,
  conversationId,
  refreshKey,
  canReview = true,
}: {
  cwd?: string;
  conversationId?: string;
  refreshKey?: unknown;
  canReview?: boolean;
}): JSX.Element | null {
  const { t } = useTranslation("sidepane");
  const openGit = useSidePaneStore((state) => state.openGit);
  const [open, setOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useGitStatus(cwd, `${String(refreshKey)}:${epoch}`);

  if (!status?.isRepository || !status.branch) return null;
  const repository = status;

  const title = t("git.headerStatus", {
    branch: repository.branch,
    additions: repository.additions,
    deletions: repository.deletions,
  });
  const changeSummary = (
    <>
      <span>{status.changed ? t("git.changedCount", { count: status.changed }) : t("git.clean")}</span>
      {status.changed ? (
        <>
          <span className="text-success tabular-nums">+{status.additions}</span>
          <span className="text-destructive tabular-nums">-{status.deletions}</span>
        </>
      ) : null}
      {status.staged ? <span className="ml-auto">{t("git.stagedCount", { count: status.staged })}</span> : null}
      {status.behind ? <span className="tabular-nums">↓{status.behind}</span> : null}
      {status.ahead ? <span className="tabular-nums">↑{status.ahead}</span> : null}
    </>
  );

  function refreshed(_next?: GitStatus): void {
    setEpoch((value) => value + 1);
  }

  async function run(
    action: BusyAction,
    operation: () => Promise<GitStatus>,
    fallback: string,
  ): Promise<GitStatus | null> {
    if (busy || !cwd) return null;
    setBusy(action);
    setError(null);
    try {
      const next = await operation();
      refreshed(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function generateMessage(): Promise<void> {
    if (busy || !cwd) return;
    setBusy("generate");
    setError(null);
    try {
      setMessage(await window.fastvibe.workspace.gitGenerateCommitMessage(repository.cwd, conversationId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("git.generateFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function commit(push: boolean): Promise<void> {
    const subject = message.trim();
    if (!cwd || busy) return;
    if (!subject) {
      setError(t("git.commitMessageRequired"));
      return;
    }
    const action = push ? "commit-push" : "commit";
    setBusy(action);
    setError(null);
    let committed = false;
    try {
      await window.fastvibe.workspace.gitStage(repository.cwd, undefined, true);
      refreshed();
      await window.fastvibe.workspace.gitCommit(repository.cwd, subject);
      committed = true;
      setMessage("");
      refreshed();
      if (push) await window.fastvibe.workspace.gitPush(repository.cwd);
      refreshed();
    } catch (cause) {
      const detail = cause instanceof Error
        ? cause.message
        : push ? t("git.commitPushFailed") : t("git.commitFailed");
      setError(committed ? t("git.pushAfterCommitFailed", { error: detail }) : detail);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) {
        setError(null);
        refreshed();
      }
    }}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={title}
            title={title}
            className="h-7 min-w-0 max-w-60 gap-1.5 rounded-md px-1.5 text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground aria-expanded:bg-muted/60 aria-expanded:text-foreground"
          />
        }
      >
        <HugeiconsIcon strokeWidth={1.8} icon={GitBranchIcon} className="size-3.5 shrink-0" />
        <span className="hidden min-w-0 truncate font-medium sm:inline">{status.branch}</span>
        {status.changed > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
            <span className="text-success">+{status.additions}</span>
            <span className="text-destructive">-{status.deletions}</span>
          </span>
        ) : (
          <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3 shrink-0 text-success" />
        )}
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={8} className="w-80 gap-0 rounded-xl p-1 shadow-lg">
        <div className="px-2 py-2">
          <div className="flex items-center gap-2">
            <HugeiconsIcon strokeWidth={2} icon={GitBranchIcon} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={status.branch}>{status.branch}</span>
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
              <IconButton
                type="button"
                variant="ghost"
                size="icon-xs"
                label={t("git.pull")}
                disabled={Boolean(busy)}
                onClick={() => void run("pull", () => window.fastvibe.workspace.gitPull(status.cwd), t("git.pullFailed"))}
              >
                {busy === "pull" ? <Spinner className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={ArrowDown02Icon} />}
              </IconButton>
              <IconButton
                type="button"
                variant="ghost"
                size="icon-xs"
                label={t("git.push")}
                disabled={Boolean(busy)}
                onClick={() => void run("push", () => window.fastvibe.workspace.gitPush(status.cwd), t("git.pushFailed"))}
              >
                {busy === "push" ? <Spinner className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} />}
              </IconButton>
            </div>
          </div>
          {canReview ? (
            <button
              type="button"
              aria-label={t("git.reviewChanges")}
              className="mt-1 flex w-full items-center gap-2 rounded-md py-1 pr-1 pl-5.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => { setOpen(false); openGit(); }}
            >
              {changeSummary}
            </button>
          ) : (
            <div className="mt-1 flex items-center gap-2 py-1 pr-1 pl-5.5 text-xs text-muted-foreground">
              {changeSummary}
            </div>
          )}
        </div>


        <div className="mt-1 flex items-center gap-2 px-2 pb-2">
          <div className="relative min-w-0 flex-1">
            <Input
              value={message}
              placeholder={t("git.commitMessage")}
              disabled={Boolean(busy)}
              className="h-8 bg-background pr-8 text-sm"
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && message.trim()) void commit(false);
              }}
            />
            <IconButton
              type="button"
              variant="ghost"
              size="icon-xs"
              label={t("git.generateMessage")}
              disabled={Boolean(busy) || !status.changed}
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
              onClick={() => void generateMessage()}
            >
              {busy === "generate" ? <Spinner className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={MagicWand02Icon} />}
            </IconButton>
          </div>
          <div className="flex shrink-0 items-center overflow-hidden rounded-lg bg-primary">
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-none pr-0.5 pl-1.5"
              disabled={Boolean(busy)}
              onClick={() => void commit(false)}
            >
              {busy === "commit" ? <Spinner className="size-3.5" /> : null}
              {t("git.commit")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    aria-label={t("git.commitOptions")}
                    className="h-8 rounded-none px-1"
                    disabled={Boolean(busy)}
                  />
                }
              >
                <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-28">
                <DropdownMenuItem onClick={() => void commit(true)}>
                  <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} />
                  {t("git.commitPush")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {error ? <p className="mx-1 mt-1 rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-5 text-destructive">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
