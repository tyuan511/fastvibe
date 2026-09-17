import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, RefreshIcon, RotateCcwIcon } from "@hugeicons/core-free-icons";
import { AppLogo } from "@/components/app-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cleanError } from "@/lib/ipc-error";
import { useSettingsStore } from "@/stores/settings";
import type { AppInfo } from "@shared/ipc";
import { AboutUpdate } from "./about-update";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * Settings → 关于: who this install is (logo, version) and what it is built from.
 *
 * Two actions live here besides the identity header: refresh the bundled models.dev
 * snapshot (limits and prices move faster than releases), and export the main/renderer
 * logs as a zip for troubleshooting.
 */
export function AboutSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const reset = useSettingsStore((state) => state.reset);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportedPath, setExportedPath] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.fastvibe.app
      .getInfo()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function updateModelsDev(): Promise<void> {
    setUpdating(true);
    setError("");
    try {
      const modelsDev = await window.fastvibe.app.updateModelsDev();
      setInfo((prev) => (prev ? { ...prev, modelsDev } : prev));
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setUpdating(false);
    }
  }

  async function exportLogs(): Promise<void> {
    setExporting(true);
    setExportError("");
    try {
      const path = await window.fastvibe.app.exportLogs();
      if (path) setExportedPath(path);
    } catch (err) {
      setExportError(cleanError(err) || t("about.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  const modelsDev = info?.modelsDev;

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

      <SettingsGroup>
        <SettingsRow
          title={t("about.modelsDev")}
          description={
            <>
              {modelsDev?.models
                ? t("about.counts", { models: modelsDev.models, aliases: modelsDev.aliases })
                : t("about.missing")}
              {/* The failure replaces nothing: the counts above are still the ones in use. */}
              {error ? <span className="mt-0.5 block text-destructive">{error}</span> : null}
            </>
          }
          control={
            <div className="flex items-center gap-3">
              {modelsDev?.generatedAt ? (
                <span className="text-xs text-muted-foreground">
                  {t("about.generatedAt", { date: new Date(modelsDev.generatedAt).toLocaleDateString() })}
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
                onClick={() => void window.fastvibe.workspace.reveal(info.userData)}
              >
                {t("about.open")}
              </Button>
            ) : null
          }
        />
      </SettingsGroup>

      <AboutUpdate />

      <SettingsGroup>
        <SettingsRow
          title={t("about.exportLogs")}
          description={
            <>
              {t("about.exportLogsDesc")}
              {exportError ? <span className="mt-0.5 block text-destructive">{exportError}</span> : null}
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
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title={t("about.reset")}
          description={t("about.resetDesc")}
          control={
            <Button variant="outline" size="xs" onClick={reset}>
              <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} />
              {t("about.resetAction")}
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  );
}
