import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsGroup, SettingsRow } from "./settings-group";
import type { ProviderConfig, ProviderModel } from "@shared/types";
import type { ProviderTestResult } from "@shared/provider-test";

export function ProviderTest({ provider, onEditModel }: { provider: ProviderConfig; onEditModel: (model: ProviderModel) => void }): JSX.Element | null {
  const { t } = useTranslation("settings");
  const [modelId, setModelId] = useState(provider.models[0]?.id ?? "");
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResult(null);
    setBusy(false);
    setModelId((id) => provider.models.some((model) => model.id === id) ? id : provider.models[0]?.id ?? "");
    return () => { generation.current++; };
  }, [provider]);
  if (!provider.models.length) return null;
  async function run(): Promise<void> {
    const ticket = ++generation.current;
    setBusy(true);
    setResult(null);
    try {
      const next = await window.fastvibe.providers.test(provider.id, modelId);
      if (ticket === generation.current) setResult(next);
    } catch {
      if (ticket === generation.current) setResult({ model: modelId, api: "", status: "failed", tools: "not-tested", elapsedMs: 0, errorCode: "network" });
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  return (
    <SettingsGroup title={t("providerTest.title")}>
      <SettingsRow title={t("providerTest.model")} description={t("providerTest.description")} control={
        <div className="flex items-center gap-2">
          <Select value={modelId} items={Object.fromEntries(provider.models.map((model) => [model.id, model.name || model.id]))} onValueChange={(id) => { if (id) { setModelId(id); setResult(null); } }} disabled={busy}>
            <SelectTrigger size="sm" className="max-w-52"><SelectValue /></SelectTrigger>
            <SelectContent>{provider.models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={busy || !modelId || (!provider.hasKey && !provider.hasOAuth)} onClick={() => void run()}>{t(busy ? "providerTest.running" : "providerTest.run")}</Button>
        </div>
      } />
      {result ? <div className="space-y-1 px-4 py-3 text-xs" role="status">
        <p className={result.status === "failed" ? "text-destructive" : result.status === "partial" ? "text-warning" : "text-success"}>{t(`providerTest.${result.status}`)}</p>
        {result.api ? <p>{t("providerTest.protocol", { api: result.api })}</p> : null}
        {result.firstTokenMs !== undefined ? <p>{t("providerTest.firstToken", { ms: result.firstTokenMs })}</p> : null}
        <p>{t(`providerTest.tools.${result.tools}`)}</p>
        {result.errorCode ? <p>{t(`providerTest.errors.${result.errorCode}`)}</p> : null}
        {result.status !== "passed" ? <Button size="xs" variant="outline" onClick={() => { const model = provider.models.find((item) => item.id === modelId); if (model) onEditModel(model); }}>{t("providerTest.edit")}</Button> : null}
      </div> : null}
    </SettingsGroup>
  );
}
