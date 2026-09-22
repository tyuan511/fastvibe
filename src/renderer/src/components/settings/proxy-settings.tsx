import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { proxySettingsOf, validProxyHost, validProxyPort, type ProxySettings as ProxyPreferences } from "@shared/proxy";
import { useSettingsStore } from "@/stores/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function ProxySettings() {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((state) => state.settings);
  const resetVersion = useSettingsStore((state) => state.resetVersion);
  const savedKey = JSON.stringify(proxySettingsOf(settings));
  const [draft, setDraft] = useState(() => proxySettingsOf(settings));
  const [port, setPort] = useState(String(draft.proxyPort));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // External changes/reset replace the draft; unrelated preferences leave it alone.
  useEffect(() => {
    const saved = JSON.parse(savedKey) as ProxyPreferences;
    setDraft(saved);
    setPort(String(saved.proxyPort));
    setError("");
  }, [savedKey, resetVersion]);

  const custom = draft.proxyEnabled && draft.proxyMode === "custom";
  const hostValid = validProxyHost(draft.proxyHost);
  const portValid = /^\d+$/.test(port) && validProxyPort(Number(port));
  // Inactive custom fields may be half-edited; never persist those fragments.
  const saved = proxySettingsOf(settings);
  const next = {
    ...draft,
    proxyHost: hostValid ? draft.proxyHost : saved.proxyHost,
    proxyPort: portValid ? Number(port) : saved.proxyPort,
  };
  const dirty = JSON.stringify(next) !== savedKey || port !== String(draft.proxyPort);
  const change = (patch: Partial<ProxyPreferences>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setError("");
  };
  async function apply() {
    setSaving(true);
    setError("");
    try {
      await useSettingsStore.getState().saveProxy(next);
    } catch (cause) {
      setError(t("proxy.saveFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setSaving(false);
    }
  }

  const modes = { system: t("proxy.system"), custom: t("proxy.custom") };
  const protocols = { http: "HTTP", socks5: "SOCKS5" };
  return (
    <SettingsGroup title={t("proxy.title")}>
      <SettingsRow title={t("proxy.enabled")} description={t("proxy.scope")} control={
        <Switch aria-label={t("proxy.enabled")} checked={draft.proxyEnabled} disabled={saving}
          onCheckedChange={(proxyEnabled) => change({ proxyEnabled })} />
      } />
      {draft.proxyEnabled && <>
        <SettingsRow title={t("proxy.mode")} description={t("proxy.systemHint")} control={
          <Select value={draft.proxyMode} items={modes} disabled={saving}
            onValueChange={(value) => { if (value) change({ proxyMode: value as ProxyPreferences["proxyMode"] }); }}>
            <SelectTrigger aria-label={t("proxy.mode")} className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="system">{modes.system}</SelectItem><SelectItem value="custom">{modes.custom}</SelectItem></SelectContent>
          </Select>
        } />
        {custom && <>
          <SettingsRow title={t("proxy.protocol")} control={
            <Select value={draft.proxyProtocol} items={protocols} disabled={saving}
              onValueChange={(value) => { if (value) change({ proxyProtocol: value as ProxyPreferences["proxyProtocol"] }); }}>
              <SelectTrigger aria-label={t("proxy.protocol")} className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="http">HTTP</SelectItem><SelectItem value="socks5">SOCKS5</SelectItem></SelectContent>
            </Select>
          } />
          <SettingsRow title={t("proxy.host")} description={!hostValid ? t("proxy.invalidHost") : t("proxy.hostHint")} control={
            <Input aria-label={t("proxy.host")} aria-invalid={!hostValid} className="w-36" value={draft.proxyHost} disabled={saving}
              onChange={(event) => change({ proxyHost: event.target.value })} />
          } />
          <SettingsRow title={t("proxy.port")} description={!portValid ? t("proxy.invalidPort") : undefined} control={
            <Input aria-label={t("proxy.port")} aria-invalid={!portValid} className="w-36" inputMode="numeric" value={port} disabled={saving}
              onChange={(event) => { setPort(event.target.value); setError(""); }} />
          } />
        </>}
      </>}
      <SettingsRow title={t("proxy.applyTitle")} description={t("proxy.limits")} control={
        <Button size="sm" variant="outline" disabled={saving || !dirty || (custom && (!hostValid || !portValid))}
          onClick={() => void apply()}>{t(saving ? "proxy.saving" : "proxy.apply")}</Button>
      } />
      {error && <p role="alert" className="px-4 py-3 text-xs text-destructive">{error}</p>}
    </SettingsGroup>
  );
}
