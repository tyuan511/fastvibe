import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cleanError } from "@/lib/ipc-error";
import type { MemoryState } from "@shared/memory";
import type { EngineModel, FastVibeModel } from "@shared/types";
import { DefaultModelSelect } from "./default-model-select";
import { SettingsGroup as Group, SettingsRow as Row } from "./settings-group";

/** 设置 → 长期记忆: one switch, plus what the memory has gathered and the means to refresh or forget it. */
export function MemorySettings({ models }: { models: FastVibeModel[] }): JSX.Element {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<MemoryState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.fastvibe.memory.getState().then((value) => { if (alive) setState(value); }).catch(() => undefined);
    const off = window.fastvibe.memory.onChanged((value) => setState(value));
    return () => { alive = false; off(); };
  }, []);

  if (!state) return <div className="p-4 text-sm text-muted-foreground">{t("memory.loading")}</div>;

  const busy = saving || state.phase !== "idle";
  const act = (call: () => Promise<MemoryState>): void => {
    setSaving(true);
    void call().then(setState).catch((cause) => toast.error(cleanError(cause))).finally(() => setSaving(false));
  };
  const status = state.phase === "extracting"
    ? t("memory.extracting")
    : state.phase === "consolidating"
      ? t("memory.consolidating")
      : state.conversations === 0
        ? t("memory.empty")
        : t("memory.counts", { count: state.conversations, pending: state.pending });

  return (
    <div className="space-y-4 p-4">
      <Group title={t("memory.title")}>
        <Row title={t("memory.enable")} description={t("memory.enableDesc")} control={
          <Switch checked={state.config.enabled} disabled={saving} onCheckedChange={(enabled) => act(() => window.fastvibe.memory.setConfig({ enabled }))} />
        } />
        <Row title={t("memory.model")} description={t("memory.modelDesc")} control={
          // `null`, not `undefined`: an undefined key does not survive the remote client's JSON.
          <DefaultModelSelect models={models} value={state.config.model} emptyLabel={t("memory.modelDefault")} className="w-56" onChange={(model: EngineModel | undefined) => act(() => window.fastvibe.memory.setConfig({ model: model ?? null }))} />
        } />
      </Group>
      <Group title={t("memory.dataTitle")}>
        <Row title={t("memory.status")} description={
          <>
            {status}
            {state.lastRunAt ? <span className="mt-0.5 block">{t("memory.lastRun", { time: new Date(state.lastRunAt).toLocaleString() })}</span> : null}
            {state.error ? <span className="mt-0.5 block text-destructive">{state.error}</span> : null}
          </>
        } control={
          <Button variant="outline" size="sm" disabled={busy || !state.config.enabled} onClick={() => act(() => window.fastvibe.memory.run())}>{t("memory.runNow")}</Button>
        } />
        <Row title={t("memory.files")} description={t("memory.filesDesc")} control={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!state.ready} onClick={() => void window.fastvibe.workspace.reveal(state.folder)}>{t("memory.open")}</Button>
            <Button variant="outline" size="sm" disabled={busy || (!state.ready && state.conversations === 0)} onClick={() => { if (window.confirm(t("memory.clearConfirm"))) act(() => window.fastvibe.memory.clear()); }}>
              {t("memory.clear")}
            </Button>
          </div>
        } />
      </Group>
    </div>
  );
}
