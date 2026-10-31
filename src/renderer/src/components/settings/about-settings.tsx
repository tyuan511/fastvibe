import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, RotateCcwIcon, StarIcon } from "@hugeicons/core-free-icons";
import { AppLogo } from "@/components/app-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cleanError } from "@/lib/ipc-error";
import { useSettingsStore } from "@/stores/settings";
import type { AppInfo } from "@shared/ipc";
import { AboutUpdate } from "./about-update";
import { SettingsGroup, SettingsRow } from "./settings-group";

function GithubMark(): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-current">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.084-.73.084-.73 1.205.084 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.292-1.552 3.297-1.23 3.297-1.23.647 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.81 1.103.81 2.222 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/**
 * Settings → 关于: who this install is (logo, version) and what it is built from.
 *
 * 开源 links to the repository. 更新 is the app's own update check. The next card
 * holds the embedded engine version and the one-shot merge into the global pi install.
 * 更多 holds the data directory, log export, and preference reset.
 */
export function AboutSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const reset = useSettingsStore((state) => state.reset);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState("");
  const [resetting, setResetting] = useState(false);
  const [engine, setEngine] = useState<import("@shared/pi-engine").PiEngineState | null>(null);
  const [switchingEngine, setSwitchingEngine] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.fastvibe.engine.getPiEngine()
      .then((next) => { if (!cancelled) setEngine(next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.fastvibe.app
      .getInfo()
      .then((next) => { if (!cancelled) setInfo(next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function switchEngine(mode: "global" | "isolated"): void {
    if (!engine || mode === engine.mode || switchingEngine) return;
    setSwitchingEngine(true);
    void window.fastvibe.engine.switchPiEngine(mode)
      .then((result) => {
        toast.success(t("about.engineSwitchDone"));
        if (!result.restartRequired) setEngine(result);
      })
      .catch((err: unknown) => toast.error(t("about.engineSwitchFailed", { error: cleanError(err) })))
      .finally(() => setSwitchingEngine(false));
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

      <SettingsGroup title={t("about.openSource")}>
        <SettingsRow
          title={
            <>
              <span className="flex size-7 items-center justify-center text-foreground">
                <GithubMark />
              </span>
              <span className="font-mono text-[13px]">tyuan511/fastvibe</span>
            </>
          }
          control={
            <Button
              size="xs"
              variant="default"
              render={<a href="https://github.com/tyuan511/fastvibe" target="_blank" rel="noreferrer" />}
              nativeButton={false}
            >
              <HugeiconsIcon strokeWidth={2} icon={StarIcon} />
              {t("about.star")}
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("about.engineSection")}>
        <SettingsRow
          title={t("about.engineMode")}
          description={t("about.engineModeDesc")}
          control={engine ? (
            <Select value={engine.mode} onValueChange={(value) => switchEngine(value as "global" | "isolated")} disabled={switchingEngine}>
              <SelectTrigger size="sm" className="w-44" aria-label={t("about.engineMode")}>
                {switchingEngine ? <Spinner className="size-3" /> : (
                  <SelectValue>
                    {engine.mode === "global" ? t("about.engineGlobal") : t("about.engineIsolated")}
                  </SelectValue>
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">{t("about.engineGlobal")}</SelectItem>
                <SelectItem value="isolated">{t("about.engineIsolated")}</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
        />
        <SettingsRow
          title={t("about.piVersion")}
          description={t("about.piVersionDesc")}
          control={<Badge variant="secondary" className="font-mono">v{info?.engineVersion ?? "—"}</Badge>}
        />
      </SettingsGroup>

      <AboutUpdate />

      <SettingsGroup title={t("about.more")}>
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
