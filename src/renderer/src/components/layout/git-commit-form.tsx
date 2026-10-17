import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, SparklesIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { APP_PLATFORM } from "@/lib/platform";
import type { GitCommitAction } from "@/lib/git-commit";

export function GitCommitForm({ message, branch, busy, canCommit, canAmend, canGenerate, onChange, onGenerate, onCommit }: {
  message: string;
  branch: string;
  busy?: string;
  canCommit: boolean;
  canAmend: boolean;
  canGenerate: boolean;
  onChange: (message: string) => void;
  onGenerate: () => void;
  onCommit: (action: GitCommitAction) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const generating = busy === "generate";
  const committing = busy && ["commit", "amend", "commit-push", "commit-sync"].includes(busy);
  const hint = t("git.commitHint", { branch, shortcut: APP_PLATFORM === "darwin" ? "⌘Enter" : "Ctrl+Enter" });
  return (
    <div className="shrink-0 space-y-2 border-b border-border p-2">
      <div className="@container/commit-input relative">
        <Textarea
          rows={1}
          value={message}
          aria-label={t("git.commitMessage")}
          aria-busy={generating}
          aria-description={hint}
          title={hint}
          className="min-h-8 max-h-40 resize-none py-1.5 pr-9 text-xs md:text-xs"
          disabled={!!busy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canCommit && !busy) onCommit("commit");
            }
          }}
        />
        {/* A native textarea placeholder wraps and increases field-sizing:content.
            Keep the empty-state hint on one line while allowing real message bodies to grow. */}
        {!message ? (
          <div aria-hidden className="pointer-events-none absolute top-1/2 right-9 left-2.5 -translate-y-1/2 text-xs text-muted-foreground">
            <span className="hidden truncate @min-[13rem]/commit-input:block">{hint}</span>
            <span className="block truncate @min-[13rem]/commit-input:hidden">{t("git.commitMessage")}</span>
          </div>
        ) : null}
        <IconButton size="icon-xs" variant="ghost" className="absolute top-1 right-1 size-6 text-muted-foreground" label={t("git.generateMessage")} disabled={!!busy || !canGenerate} onClick={onGenerate}>
          {generating ? <Spinner className="size-3.5" /> : <HugeiconsIcon icon={SparklesIcon} strokeWidth={1.8} className="size-4" />}
        </IconButton>
      </div>
      <div className="flex w-full overflow-hidden rounded-md bg-primary text-primary-foreground">
        <Button size="sm" className="h-8 min-w-0 flex-1 rounded-none text-xs" disabled={!!busy || !canCommit} onClick={() => onCommit("commit")}>
          {committing ? <Spinner /> : <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />}{t("git.commit")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" className="h-8 w-8 shrink-0 rounded-none border-0 border-l border-primary-foreground/25 px-0" aria-label={t("git.commitOptions")} disabled={!!busy} />}>
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={5} className="min-w-44">
            <DropdownMenuItem disabled={!canCommit} onClick={() => onCommit("commit")}>{t("git.commit")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canAmend} onClick={() => onCommit("amend")}>{t("git.commitAmend")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!canCommit} onClick={() => onCommit("commit-push")}>{t("git.commitPush")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canCommit} onClick={() => onCommit("commit-sync")}>{t("git.commitSync")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
