import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { DEFAULT_PROXY_SETTINGS, normalizeProxyUrl, proxySettingsOf, type ProxySettings as ProxyPreferences } from "@shared/proxy";
import { useSettingsStore } from "@/stores/settings";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * Every change is written the moment it is made: there is no draft to apply and no
 * button to press before the network follows what is on screen.
 *
 * The address is the one exception — it commits on blur / Enter, because a half-typed
 * `http://1` is a syntactically fine proxy host and saving per keystroke would route
 * everything there on the way to `http://127.0.0.1:7890`, cutting the connection this
 * pane may itself be sitting on.
 */
export function ProxySettings() {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((state) => state.settings);
  const resetVersion = useSettingsStore((state) => state.resetVersion);
  const savedKey = JSON.stringify(proxySettingsOf(settings));
  // The control moves at once rather than waiting for Main's reply; a save that fails
  // pulls it back to what is actually in effect, so the pane never lies about the network.
  const [draft, setDraft] = useState<ProxyPreferences>(() => JSON.parse(savedKey) as ProxyPreferences);
  const [url, setUrl] = useState(draft.proxyUrl);
  const adopted = useRef<ProxyPreferences>(draft);

  // Another window's write or 恢复默认 replaces what this pane describes. An address that
  // is being typed in keeps its text — this pass also runs for the pane's own saves, and
  // wiping it there would eat the characters typed while the write was in flight.
  useEffect(() => {
    const next = JSON.parse(savedKey) as ProxyPreferences;
    const previous = adopted.current;
    adopted.current = next;
    setDraft(next);
    setUrl((value) => (value === previous.proxyUrl ? next.proxyUrl : value));
  }, [savedKey, resetVersion]);

  const custom = draft.proxyEnabled && draft.proxyMode === "custom";
  const canonical = normalizeProxyUrl(url);

  async function commit(next: ProxyPreferences) {
    if (JSON.stringify(next) === savedKey) return;
    setDraft(next);
    try {
      await useSettingsStore.getState().saveProxy(next);
    } catch (cause) {
      toast.error(t("proxy.saveFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
      setDraft(JSON.parse(savedKey) as ProxyPreferences);
    }
  }
  const change = (patch: Partial<ProxyPreferences>) => void commit({ ...draft, ...patch });
  /** An address that is not one stays in the box with its hint and keeps the last good value. */
  const commitUrl = () => void commit({ ...draft, proxyUrl: canonical ?? draft.proxyUrl });

  const modes = { system: t("proxy.system"), custom: t("proxy.custom") };
  return (
    <SettingsGroup title={t("proxy.title")}>
      <SettingsRow title={t("proxy.enabled")} description={t("proxy.scope")} control={
        <Switch aria-label={t("proxy.enabled")} checked={draft.proxyEnabled}
          onCheckedChange={(proxyEnabled) => change({ proxyEnabled })} />
      } />
      {draft.proxyEnabled && <>
        <SettingsRow title={t("proxy.mode")} description={t("proxy.systemHint")} control={
          <Select value={draft.proxyMode} items={modes}
            onValueChange={(value) => { if (value) change({ proxyMode: value as ProxyPreferences["proxyMode"] }); }}>
            <SelectTrigger aria-label={t("proxy.mode")} className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="system">{modes.system}</SelectItem><SelectItem value="custom">{modes.custom}</SelectItem></SelectContent>
          </Select>
        } />
        {custom && (
          <SettingsRow title={t("proxy.url")} description={canonical ? t("proxy.urlHint") : t("proxy.invalidUrl")} control={
            <Input aria-label={t("proxy.url")} aria-invalid={!canonical} className="w-72 font-mono"
              placeholder={DEFAULT_PROXY_SETTINGS.proxyUrl}
              value={url} spellCheck={false} autoCapitalize="off" autoCorrect="off"
              onChange={(event) => setUrl(event.target.value)} onBlur={commitUrl}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          } />
        )}
      </>}
    </SettingsGroup>
  );
}
