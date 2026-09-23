import { useCallback, useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { useSettingsStore, type AppSettings } from "@/stores/settings";
import { Ipc } from "@shared/ipc";
import type { BrowserImportResult, BrowserProfileInfo } from "@shared/types";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow } from "./settings-group";

type EngineId = AppSettings["browserEngine"];

/**
 * 浏览器控制.
 *
 * The switch used to live under 偏好设置 → 运行时, next to keep-awake, which is where
 * nobody looked for it. It decides whether browser-use drives the side pane or a
 * real browser over CDP, so it belongs with the choice of *which* browser and the
 * import that fills that browser's profile — the same three questions, one pane.
 */
export function BrowserSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);

  const remote = blockedRemotely(Ipc.browserListProfiles);
  const [engines, setEngines] = useState<Array<{ id: string; label: string }>>([{ id: "auto", label: "" }]);
  const [profiles, setProfiles] = useState<BrowserProfileInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (remote) return;
    setLoading(true);
    try {
      const [found, list] = await Promise.all([
        window.fastvibe.browser.listEngines(),
        window.fastvibe.browser.listProfiles(),
      ]);
      if (found.length > 0) setEngines(found);
      setProfiles(list);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, [remote]);

  useEffect(() => {
    void load();
  }, [load]);

  async function importProfile(profile: BrowserProfileInfo): Promise<void> {
    if (blockedRemotely(Ipc.browserImportProfile)) return;
    setImporting(profile.id);
    try {
      const result: BrowserImportResult = await window.fastvibe.browser.importProfile(profile, settings.browserUseSystem ? "system" : "builtin");
      toast.success(t("browser.importDone", { browser: result.browser, profile: result.profile }), {
        description: result.message,
      });
    } catch (error) {
      toast.error(t("browser.importFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImporting(null);
    }
  }

  const engineItems = Object.fromEntries(
    engines.map((engine) => [engine.id, engine.id === "auto" ? t("browser.auto") : engine.label]),
  );
  const selected = engines.some((engine) => engine.id === settings.browserEngine) ? settings.browserEngine : "auto";

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t("browser.control")}>
        <SettingsRow
          title={t("browser.useSystem")}
          description={t("browser.useSystemDesc")}
          control={
            <Switch
              checked={settings.browserUseSystem}
              onCheckedChange={(checked) => update({ browserUseSystem: checked })}
            />
          }
        />
        <SettingsRow
          title={t("browser.engine")}
          description={t("browser.engineDesc")}
          control={
            <Select
              items={engineItems}
              value={selected}
              disabled={!settings.browserUseSystem}
              onValueChange={(value) => { if (value) update({ browserEngine: value as EngineId }); }}
            >
              <SelectTrigger size="sm" aria-label={t("browser.engine")} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {engines.map((engine) => (
                  <SelectItem key={engine.id} value={engine.id}>
                    {engine.id === "auto" ? t("browser.auto") : engine.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("browser.import")}>
        <SettingsRow title={t("browser.importTitle")} description={t(settings.browserUseSystem ? "browser.importDescSystem" : "browser.importDesc")} control={null} />
        {remote ? (
          <SettingsRow title={t("browser.remote")} description={t("browser.remoteDesc")} control={null} />
        ) : profiles === null || loading ? (
          <SettingsRow title={t("browser.loading")} control={null} />
        ) : profiles.length === 0 ? (
          <SettingsRow title={t("browser.noProfiles")} description={t("browser.noProfilesDesc")} control={null} />
        ) : (
          profiles.map((profile) => (
            <SettingsRow
              key={profile.id}
              title={`${profile.browser} · ${profile.name}`}
              description={t("browser.profileDesc")}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={importing !== null}
                  onClick={() => void importProfile(profile)}
                >
                  {importing === profile.id ? t("browser.importing") : t("browser.importAction")}
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>
    </div>
  );
}
