import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Download01Icon, FolderOpenIcon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { IconButton } from "@/components/icon-button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { BrowserDownloadAction, BrowserLibrary } from "@shared/browser-workspace";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function BrowserDownloadsPopover({ open, onOpenChange, library, error }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  library: BrowserLibrary | null;
  error: string | null;
}) {
  const { t } = useTranslation("sidepane");
  const [busy, setBusy] = useState<string | null>(null);
  const activeDownloads = library?.downloads.filter((item) => item.state === "progressing").length ?? 0;

  async function act(id: string, action: BrowserDownloadAction): Promise<void> {
    setBusy(id);
    try { await window.fastvibe.browser.downloadAction(id, action); }
    catch (error) { toast.error(String(error)); }
    finally { setBusy(null); }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverTrigger render={
        <IconButton type="button" size="icon-xs" variant="ghost" className="relative" label={t("browser.downloads")}>
          <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />
          {activeDownloads > 0 && <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-xs text-primary-foreground">{activeDownloads}</span>}
        </IconButton>
      } />
      <PopoverContent
        align="end"
        sideOffset={8}
        className="max-h-[min(28rem,var(--available-height))] w-96 max-w-[calc(100vw-1rem)] gap-0 p-0"
        onKeyDownCapture={(event) => {
          // A focused action's tooltip must not consume the first Escape.
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }}
      >
        <PopoverHeader className="shrink-0 border-b border-border/60 px-3 py-2.5">
          <PopoverTitle>{t("browser.downloads")}</PopoverTitle>
          <PopoverDescription className="sr-only">{t("browser.downloadsDescription")}</PopoverDescription>
        </PopoverHeader>
        <div className="min-h-0 overflow-y-auto px-3" aria-live="polite">
          {error ? (
            <p className="py-6 text-center text-sm text-destructive">{error}</p>
          ) : !library ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("browser.loadingRecords")}</p>
          ) : library.downloads.length ? library.downloads.map((item) => {
            const resumable = item.paused || item.state === "interrupted";
            const resumeLabel = t(resumable ? "browser.resumeDownload" : "browser.pauseDownload");
            return (
              <div key={item.id} className="flex items-center gap-2 border-b border-border/60 py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm" title={item.path || item.name}>{item.name}</p>
                  <p className="truncate text-xs text-muted-foreground" title={item.url}>{item.url}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`browser.downloadState.${item.paused ? "paused" : item.state}`)} · {bytes(item.received)}{item.total > 0 ? ` / ${bytes(item.total)}` : ""}
                  </p>
                  {item.state === "progressing" && <progress aria-label={item.name} className="mt-1 h-1 w-full accent-primary" max={item.total || undefined} value={item.total ? item.received : undefined} />}
                </div>
                {item.state === "completed" ? (
                  <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" label={t("browser.revealDownload")} onClick={() => void act(item.id, "reveal")} focusableWhenDisabled disabled={busy === item.id}>
                    <HugeiconsIcon icon={FolderOpenIcon} />
                  </IconButton>
                ) : item.state === "progressing" || item.canResume ? (
                  <div className="flex shrink-0">
                    <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" label={resumeLabel} focusableWhenDisabled disabled={busy === item.id} onClick={() => void act(item.id, resumable ? "resume" : "pause")}>
                      <HugeiconsIcon icon={resumable ? PlayIcon : PauseIcon} />
                    </IconButton>
                    <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" label={t("browser.cancelDownload")} focusableWhenDisabled disabled={busy === item.id} onClick={() => void act(item.id, "cancel")}>
                      <HugeiconsIcon icon={Cancel01Icon} />
                    </IconButton>
                  </div>
                ) : null}
              </div>
            );
          }) : <p className="py-6 text-center text-sm text-muted-foreground">{t("browser.downloadsEmpty")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
