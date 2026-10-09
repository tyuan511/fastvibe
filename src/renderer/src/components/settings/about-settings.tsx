import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, RefreshIcon, RotateCcwIcon } from "@hugeicons/core-free-icons";
import { AppLogo } from "@/components/app-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cleanError } from "@/lib/ipc-error";
import { useSettingsStore } from "@/stores/settings";
import type { AppInfo } from "@shared/ipc";
import { AboutUpdate } from "./about-update";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * Settings → 关于: who this install is (logo, version) and what it is built from.
 *
 * Three cards below the identity header. 更新 is the app's own update check. The next card
 * is the embedded engine: its pi coding agent version, and the one-shot merge of the
 * connected config into the global pi install. 更多 holds everything else about this
 * install: the models.dev snapshot (refreshable now; it also refreshes on its own hourly —
 * limits and prices move faster than releases), where its data lives, exporting the
 * main/renderer logs as a zip, and resetting preferences.
 */
export function AboutSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const reset = useSettingsStore((state) => state.reset);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState("");
  const [resetting, setResetting] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);
  const [syncing, setSyncing] = useState<"merge" | "replace" | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A refresh that lands before getInfo returns would otherwise be overwritten by
    // the snapshot the page asked for a moment earlier.
    let live: AppInfo["modelsDev"];
    const off = window.fastvibe.app.onModelsDev((modelsDev) => {
      live = modelsDev;
      if (!cancelled) setInfo((prev) => (prev ? { ...prev, modelsDev } : prev));
    });
    void window.fastvibe.app
      .getInfo()
      .then((next) => {
        if (!cancelled) setInfo(live ? { ...next, modelsDev: live } : next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  async function updateModelsDev(): Promise<void> {
    setUpdating(true);
    try {
      const modelsDev = await window.fastvibe.app.updateModelsDev();
      setInfo((prev) => (prev ? { ...prev, modelsDev } : prev));
      toast.success(t("about.updated"));
    } catch (err) {
      toast.error(cleanError(err));
    } finally {
      setUpdating(false);
    }
  }

  async function exportLogs(): Promise<void> {
    // The zip lands in the host's downloads, where a remote caller cannot get at it.
    setExporting(true);
    try {
      const path = await window.fastvibe.app.exportLogs();
      if (path) setExportedPath(path);
    } catch (err) {
      toast.error(cleanError(err) || t("about.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  const modelsDev = info?.modelsDev;

  function syncConfig(mode: "merge" | "replace"): void {
    setSyncing(mode);
    void window.fastvibe.engine
      .syncPiConfig(mode)
      .then((report) => {
        setConfirmSync(false);
        if (report.unchanged) toast.success(t("about.syncUnchanged"));
        else toast.success(report.backupDir ? t("about.syncDoneBackup") : t("about.syncDone"));
      })
      .catch((err: unknown) => {
        toast.error(t("about.syncFailed", { error: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => setSyncing(null));
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        <AppLogo className="size-14 shrink-0" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold tracking-tight">FastVibe</h3>
            <Badge variant="secondary" className="font-mono">
              v{info?.version ?? "—"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("about.tagline")}</p>
        </div>
      </header>

      <AboutUpdate />

      <SettingsGroup>
        <SettingsRow
          title={t("about.engine")}
          description={t("about.engineDesc")}
          control={
            <span className="font-mono text-sm">{info?.engineVersion ?? "—"}</span>
          }
        />
        <SettingsRow
          title={t("about.sync")}
          description={t("about.syncDesc")}
          control={
            <Button size="xs" variant="outline" disabled={syncing !== null} onClick={() => setConfirmSync(true)}>
              {syncing ? t("about.syncing") : t("about.syncAction")}
            </Button>
          }
        />
      </SettingsGroup>

      <Dialog open={confirmSync} onOpenChange={(open) => { if (!syncing) setConfirmSync(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("about.syncConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("about.syncConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={syncing !== null} onClick={() => setConfirmSync(false)}>
              {t("about.syncCancel")}
            </Button>
            <Button variant="outline" disabled={syncing !== null} onClick={() => syncConfig("merge")}>
              {syncing === "merge" ? t("about.syncing") : t("about.syncMerge")}
            </Button>
            <Button disabled={syncing !== null} onClick={() => syncConfig("replace")}>
              {syncing === "replace" ? t("about.syncing") : t("about.syncReplace")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingsGroup title={t("about.more")}>
        <SettingsRow
          title={t("about.modelsDev")}
          description={
            <>
              {modelsDev?.models
                ? t("about.counts", { models: modelsDev.models, aliases: modelsDev.aliases })
                : t("about.missing")}
              <span className="mt-0.5 block">{t("about.autoRefresh")}</span>
              {/* The failure replaces nothing: the counts above are still the ones in use. */}
            </>
          }
          control={
            <div className="flex items-center gap-3">
              {modelsDev?.generatedAt ? (
                <span className="text-xs text-muted-foreground">
                  {t("about.generatedAt", { date: new Date(modelsDev.generatedAt).toLocaleString() })}
                </span>
              ) : null}
              <Button size="xs" variant="outline" disabled={updating} onClick={() => void updateModelsDev()}>
                {updating ? (
                  <Spinner className="size-3" />
                ) : (
                  <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
                )}
                {t(updating ? "about.updating" : "about.update")}
              </Button>
            </div>
          }
        />
        <SettingsRow
          title={t("about.dataDir")}
          description={<span className="break-all font-mono">{info?.userData ?? "—"}</span>}
          control={
            info ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void window.fastvibe.workspace.reveal(info.userData);
                }}
              >
                {t("about.open")}
              </Button>
            ) : null
          }
        />
        <SettingsRow
          title={t("about.exportLogs")}
          description={
            <>
              {t("about.exportLogsDesc")}
              {exportedPath ? (
                <span className="mt-0.5 block break-all font-mono">{t("about.exported", { path: exportedPath })}</span>
              ) : null}
            </>
          }
          control={
            <Button size="xs" variant="outline" disabled={exporting} onClick={() => void exportLogs()}>
              {exporting ? <Spinner className="size-3" /> : <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />}
              {t(exporting ? "about.exporting" : "about.exportLogsAction")}
            </Button>
          }
        />
        <SettingsRow
          title={t("about.reset")}
          description={<>{t("about.resetDesc")}</>}
          control={
            <Button variant="outline" size="xs" disabled={resetting} onClick={() => {
              setResetting(true);
              void reset().catch((error) => toast.error(cleanError(error))).finally(() => setResetting(false));
            }}>
              <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} />
              {t("about.resetAction")}
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  );
}
