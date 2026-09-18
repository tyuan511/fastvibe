import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { useAppUpdate } from "@/lib/use-app-update";
import { ReleaseNotes } from "./release-notes";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * The manual 「检查更新」 flow, in one panel: the check runs on open, a found version
 * shows its release notes and waits for the user to confirm, the download then reports
 * its progress in the same panel, and it ends on a restart prompt. Downloads are never
 * automatic, so the panel always owns the decision.
 */
export function UpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const update = useAppUpdate();
  const [checking, setChecking] = useState(false);
  // Read the freshest state inside the open effect without re-running it per event.
  const latest = useRef(update);
  latest.current = update;

  const runCheck = useCallback((): void => {
    // Reachable without a click — the dialog checks on open — so this guard is what
    // keeps a remote client from opening it into a refusal it never asked for.
    if (blockedRemotely(Ipc.updateCheck)) return;
    setChecking(true);
    void window.fastvibe.updater
      .check()
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    const status = latest.current?.status;
    // A check in flight, or a version already found or downloaded, is the panel's
    // content — re-asking would only throw it away.
    if (status === "checking" || status === "available" || status === "downloading" || status === "downloaded") return;
    runCheck();
  }, [open, runCheck]);

  const status = update?.status;
  // Main reports `downloading` with no progress the moment the click lands, before the
  // provider has moved any bytes — that gap is a spinner, not a 0% bar.
  const downloadingStarted = status === "downloading" && !update?.progress;
  const inFlight = checking || status === "checking" || downloadingStarted;
  const percent = Math.round(update?.progress?.percent ?? 0);
  const bytes = update?.progress
    ? `${formatBytes(update.progress.transferred)} / ${formatBytes(update.progress.total)}`
    : "";

  const description = checking || status === "checking"
    ? t("update.checking")
    : downloadingStarted
      ? t("update.downloadingStart", { version: update?.availableVersion ?? t("update.newVersion") })
      : status === "available"
        ? t("update.dialogAvailableTitle", { version: update?.availableVersion })
        : status === "downloading"
          ? t("update.dialogDownloadingTitle", { version: update?.availableVersion ?? t("update.newVersion") })
          : status === "downloaded"
            ? t("update.ready", { version: update?.availableVersion })
            : status === "disabled"
              ? t("update.disabled")
              : status === "error"
                ? update?.error || t("update.failed")
                : t("update.latest");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("update.dialogTitle")}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {inFlight ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : null}

        {status === "available" ? (
          <div className="min-w-0">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("update.dialogNotes")}</p>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-sm">
              {update?.releaseNotes ? (
                <ReleaseNotes notes={update.releaseNotes} />
              ) : (
                <p className="text-muted-foreground">{t("update.dialogNoNotes")}</p>
              )}
            </div>
          </div>
        ) : null}

        {status === "downloading" && update?.progress ? (
          <div className="space-y-1.5">
            <Progress value={percent} />
            <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
              <span>{percent}%</span>
              <span>{bytes}</span>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {status === "downloaded" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("update.later")}
              </Button>
              <Button
                onClick={() => {
                  if (blockedRemotely(Ipc.updateInstall)) return;
                  void window.fastvibe.updater.install();
                }}
              >
                <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
                {t("update.restart")}
              </Button>
            </>
          ) : status === "available" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("update.later")}
              </Button>
              <Button
                onClick={() => {
                  if (blockedRemotely(Ipc.updateDownload)) return;
                  void window.fastvibe.updater.download();
                }}
              >
                <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />
                {t("update.updateNow")}
              </Button>
            </>
          ) : status === "error" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("update.close")}
              </Button>
              <Button onClick={runCheck}>
                <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
                {t("update.retry")}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("update.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
