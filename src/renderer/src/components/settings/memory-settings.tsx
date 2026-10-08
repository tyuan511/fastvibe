import { useEffect, useState, type JSX } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Alert02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cleanError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";
import type { DecisionKeyState, DecisionModelConfig } from "@shared/decision";
import type { MemoryMode, MemoryModelState, MemoryState } from "@shared/memory";
import type { EngineModel, FastVibeModel } from "@shared/types";
import { DefaultModelSelect } from "./default-model-select";
import { MemoryGraphDialog } from "./memory-graph";
import { SettingsGroup as Group, SettingsRow as Row } from "./settings-group";

type DecisionSetup = { config: DecisionModelConfig; keys: DecisionKeyState };

export function MemorySettings({ models }: { models: FastVibeModel[] }): JSX.Element {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const [state, setState] = useState<MemoryState | null>(null);
  const [decision, setDecision] = useState<DecisionSetup | null>(null);
  const [modeDraft, setModeDraft] = useState<MemoryMode | null>(null);
  const [draftSystemTwoModel, setDraftSystemTwoModel] = useState<EngineModel | undefined>();
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.fastvibe.memory.getState().then((value) => { if (alive) setState(value); }).catch(() => undefined);
    const off = window.fastvibe.memory.onChanged((value) => setState(value));
    return () => { alive = false; off(); };
  }, []);

  useEffect(() => {
    if (state?.config.mode !== "jev" && modeDraft !== "jev") return;
    let alive = true;
    void readDecisionSetup().then((value) => { if (alive && value) setDecision(value); });
    const off = window.fastvibe.decision.onChanged((config) => {
      setDecision((current) => current ? { ...current, config } : current);
      void readDecisionSetup().then((value) => { if (alive && value) setDecision(value); });
    });
    return () => { alive = false; off(); };
  }, [state?.config.mode, modeDraft]);

  async function readDecisionSetup(): Promise<DecisionSetup | undefined> {
    try {
      const [config, keys] = await Promise.all([window.fastvibe.decision.getConfig(), window.fastvibe.decision.keyState()]);
      return { config, keys };
    } catch {
      return undefined;
    }
  }

  const update = async (patch: Record<string, unknown>): Promise<MemoryState | undefined> => {
    setSaving(true);
    try {
      const next = await window.fastvibe.memory.setConfig(patch);
      setState(next);
      return next;
    } catch (cause) {
      setState(await window.fastvibe.memory.getState().catch(() => state));
      throw cause;
    } finally {
      setSaving(false);
    }
  };

  const openModeDialog = (value: string): void => {
    const mode: MemoryMode = value === "semantic" || value === "jev" ? value : "default";
    if (!state || saving || preparing) return;
    if (mode === "default") {
      void update({ mode }).catch((cause) => toast.error(cleanError(cause)));
      return;
    }
    setDraftSystemTwoModel(state.config.systemTwoModel);
    setModeDraft(mode);
    if (mode === "jev") void readDecisionSetup().then((value) => { if (value) setDecision(value); });
  };

  const applyMode = async (): Promise<void> => {
    if (!modeDraft || !state || preparing) return;
    const jevReady = decision?.config.kind === "jev" && decision.keys.jev && decision.config.memoryControl === true;
    if (modeDraft === "jev" && (!jevReady || !draftSystemTwoModel)) return;
    setPreparing(true);
    try {
      if (state.model.status !== "ready") setState(await window.fastvibe.memory.prepareModel());
      const next = await window.fastvibe.memory.setConfig({ mode: modeDraft, systemTwoModel: draftSystemTwoModel });
      setState(next);
      setModeDraft(null);
    } catch (cause) {
      toast.error(modeDraft === "semantic" || modeDraft === "jev" ? t("memory.downloadFailed", { error: cleanError(cause) }) : cleanError(cause));
    } finally {
      setPreparing(false);
    }
  };

  // Progress arrives through `onChanged` while this is pending; a failure is already on
  // the row as the model's error state, so there is nothing more to say in a toast.
  const downloadModel = (): void => {
    void window.fastvibe.memory.prepareModel().then(setState).catch(() => window.fastvibe.memory.getState().then(setState));
  };

  // `null`, not `undefined`: an undefined key does not survive the remote client's JSON.
  const setSystemTwoModel = (model: EngineModel | undefined): void => {
    void update({ systemTwoModel: model ?? null }).catch((cause) => toast.error(cleanError(cause)));
  };

  const goToDecisionSetup = async (): Promise<void> => {
    const currentModel = state?.config.systemTwoModel;
    if (draftSystemTwoModel && (currentModel?.provider !== draftSystemTwoModel.provider || currentModel?.id !== draftSystemTwoModel.id)) {
      await update({ systemTwoModel: draftSystemTwoModel }).catch((cause) => toast.error(cleanError(cause)));
    }
    setModeDraft(null);
    navigate("/settings/decision", { replace: true });
  };

  if (!state) return <div className="p-4 text-sm text-muted-foreground">{t("memory.loading")}</div>;
  const modelControl = state.model.status === "downloading"
    ? <ModelProgress model={state.model} className="w-52" />
    : state.model.status === "ready"
      ? <span className="text-xs text-muted-foreground">{t("memory.modelReady")}</span>
      : <Button variant="outline" size="sm" onClick={downloadModel}>{state.model.status === "error" ? t("memory.modelRetry") : t("memory.modelDownload")}</Button>;
  const modeLabels: Record<MemoryMode, string> = { default: t("memory.default"), semantic: t("memory.semantic"), jev: t("memory.jev") };
  const modeDescription = state.config.mode === "semantic"
    ? t("memory.semanticDesc")
    : state.config.mode === "jev"
      ? t("memory.jevDesc")
      : t("memory.defaultDesc");
  const jevReady = decision?.config.kind === "jev" && decision.keys.jev && decision.config.memoryControl === true && Boolean(state.config.systemTwoModel);
  const dialogDecisionReady = decision?.config.kind === "jev" && decision.keys.jev && decision.config.memoryControl === true;
  const dialogTitle = modeDraft === "jev" ? t("memory.configureJevTitle") : t("memory.configureSemanticTitle");

  return (
    <div className="space-y-4 p-4">
      <Group title={t("memory.title")}>
        <Row title={t("memory.mode")} description={modeDescription} control={
          <Select value={state.config.mode} items={modeLabels} disabled={saving || preparing} onValueChange={(value) => openModeDialog(value ?? "default")}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{modeLabels.default}</SelectItem>
              <SelectItem value="semantic">{modeLabels.semantic}</SelectItem>
              <SelectItem value="jev">{modeLabels.jev}</SelectItem>
            </SelectContent>
          </Select>
        } />
        <Row title={t("memory.autoCapture")} description={t("memory.autoCaptureDesc")} control={
          <Switch checked={state.config.autoCapture} disabled={saving || preparing} onCheckedChange={(checked) => void update({ autoCapture: checked }).catch((cause) => toast.error(cleanError(cause)))} />
        } />
      </Group>
      {state.config.mode === "semantic" || state.config.mode === "jev" ? (
        <Group title={t("memory.modelTitle")}>
          <Row title={t("memory.model")} description={
            <>
              {t("memory.modelDesc")}
              {state.model.status === "error" ? <span className="mt-0.5 block text-destructive">{t("memory.modelError", { error: state.model.error ?? "" })}</span> : null}
            </>
          } control={modelControl} />
        </Group>
      ) : null}
      <Group title={t("memory.systemTwoTitle")}>
        <Row title={t("memory.systemTwoModel")} description={state.config.systemTwoModel ? t("memory.systemTwoModelDesc") : t("memory.systemTwoModelMissing")} control={
          // JEV cannot run without it (Main refuses the config), so there it offers no way back to none.
          <DefaultModelSelect models={models} value={state.config.systemTwoModel} emptyLabel={t("memory.systemTwoModelUnset")} onChange={setSystemTwoModel} required={state.config.mode === "jev"} className="w-56" />
        } />
      </Group>
      {state.config.mode === "jev" && !jevReady ? (
        <Group title={t("memory.jev")}>
          <Row title={t("memory.jevNeedsDecision")} control={<Button variant="outline" size="sm" onClick={() => navigate("/settings/decision", { replace: true })}>{t("memory.goToDecision")}</Button>} />
        </Group>
      ) : null}
      <Group title={t("memory.maintenanceTitle")}>
        <Row title={t("memory.autoMaintain")} description={t("memory.autoMaintainDesc")} control={
          <Switch checked={state.config.autoMaintain} disabled={saving} onCheckedChange={(checked) => void update({ autoMaintain: checked }).catch((cause) => toast.error(cleanError(cause)))} />
        } />
        <Row title={t("memory.temporaryRetention")} description={t("memory.temporaryRetentionDesc")} control={
          <RetentionSelect value={state.config.temporaryRetentionDays} options={[30, 90, 180, 365]} disabled={saving || !state.config.autoMaintain} label={t("memory.temporaryRetention")} format={(value) => t("memory.days", { count: value })} onChange={(value) => void update({ temporaryRetentionDays: value }).catch((cause) => toast.error(cleanError(cause)))} />
        } />
        <Row title={t("memory.archiveRetention")} description={t("memory.archiveRetentionDesc")} control={
          <RetentionSelect value={state.config.archiveRetentionDays} options={[7, 30, 90]} disabled={saving || !state.config.autoMaintain} label={t("memory.archiveRetention")} format={(value) => t("memory.days", { count: value })} onChange={(value) => void update({ archiveRetentionDays: value }).catch((cause) => toast.error(cleanError(cause)))} />
        } />
        <Row title={t("memory.maxActive")} description={t("memory.maxActiveDesc")} control={
          <RetentionSelect value={state.config.maxActiveItems} options={[1000, 5000, 10000, 50000]} disabled={saving || !state.config.autoMaintain} label={t("memory.maxActive")} format={(value) => t("memory.itemCount", { count: value })} onChange={(value) => void update({ maxActiveItems: value }).catch((cause) => toast.error(cleanError(cause)))} />
        } />
        <Row title={t("memory.maintenanceStatus")} description={
          <>
            {t("memory.maintenanceCounts", { active: state.maintenance?.active ?? state.items, archived: state.maintenance?.archived ?? 0 })}
            <span className="mt-0.5 block">{!state.config.autoMaintain ? t("memory.maintenancePaused") : state.maintenance?.pending ? t("memory.maintenancePending") : state.maintenance?.lastRunAt ? t("memory.maintenanceLastRun", { time: new Date(state.maintenance.lastRunAt).toLocaleString(), archived: state.maintenance.archivedLastRun ?? 0, deleted: state.maintenance.deletedLastRun ?? 0 }) : t("memory.maintenanceNotRun")}</span>
            {state.maintenance?.overBudget ? <span className="mt-0.5 block text-warning">{t("memory.maintenanceOverBudget", { count: state.maintenance.overBudget })}</span> : null}
            {state.maintenance?.error ? <span className="mt-0.5 block text-destructive">{state.maintenance.error}</span> : null}
          </>
        } control={
          <Button variant="outline" size="sm" disabled={saving || !state.config.autoMaintain || state.maintenance?.pending} onClick={() => {
            setSaving(true);
            void window.fastvibe.memory.maintain().then(setState).catch((cause) => toast.error(cleanError(cause))).finally(() => setSaving(false));
          }}>{t("memory.maintainNow")}</Button>
        } />
      </Group>
      <Group title={t("memory.dataTitle")}>
        <Row title={t("memory.indexed")} description={t("memory.indexedDesc", { items: state.items, edges: state.edges })} control={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={saving || state.items === 0} onClick={() => { if (window.confirm(t("memory.clearConfirm"))) void window.fastvibe.memory.clear().then(setState); }}>
              {t("memory.clear")}
            </Button>
            <Button variant="outline" size="sm" disabled={state.items === 0} onClick={() => setGraphOpen(true)}>{t("memory.graphOpen")}</Button>
          </div>
        } />
      </Group>
      <MemoryGraphDialog open={graphOpen} onOpenChange={setGraphOpen} />

      <Dialog open={modeDraft !== null} onOpenChange={(open) => { if (!open && !preparing) setModeDraft(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{modeDraft === "jev" ? t("memory.configureJevDesc") : t("memory.configureSemanticDesc")}</DialogDescription>
          </DialogHeader>
          {modeDraft === "jev" ? (
            <div className="space-y-3">
              <Checklist ok={Boolean(dialogDecisionReady)} label={dialogDecisionReady ? t("memory.decisionReady") : t("memory.decisionMissing")} />
              <Checklist ok={Boolean(draftSystemTwoModel)} label={draftSystemTwoModel ? t("memory.systemTwoModel") : t("memory.systemTwoModelMissing")} />
              {state.model.status === "downloading"
                ? <ModelProgress model={state.model} />
                : <Checklist ok={state.model.status === "ready"} label={state.model.status === "ready" ? t("memory.modelReady") : t("memory.modelNotInstalled")} />}
              <DefaultModelSelect models={models} value={draftSystemTwoModel} emptyLabel={t("memory.systemTwoModelUnset")} onChange={setDraftSystemTwoModel} className="w-full" wrapLabel />
              {!dialogDecisionReady ? <Button variant="outline" size="sm" onClick={() => void goToDecisionSetup()}>{t("memory.goToDecision")}</Button> : null}
            </div>
          ) : (
            state.model.status === "downloading"
              ? <ModelProgress model={state.model} />
              : <Checklist ok={state.model.status === "ready"} label={state.model.status === "ready" ? t("memory.modelReady") : t("memory.downloadConfirm")} />
          )}
          <DialogFooter>
            <Button variant="outline" disabled={preparing} onClick={() => setModeDraft(null)}>{t("memory.configureCancel")}</Button>
            <Button disabled={preparing || (modeDraft === "jev" && (!dialogDecisionReady || !draftSystemTwoModel))} onClick={() => void applyMode()}>
              {preparing ? t("memory.configurePreparing") : t("memory.configureEnable")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Checklist({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return <div className="flex items-center gap-2 text-sm"><HugeiconsIcon strokeWidth={2} icon={ok ? CheckmarkCircle02Icon : Alert02Icon} className={ok ? "size-4 text-success" : "size-4 text-warning"} />{label}</div>;
}

/** The embedding download as it runs: one bar across every model file, with the bytes when known. */
function ModelProgress({ model, className }: { model: MemoryModelState; className?: string }): JSX.Element {
  const { t } = useTranslation("settings");
  const percent = Math.round((model.progress ?? 0) * 100);
  return (
    <div className={cn("space-y-1.5", className)}>
      <Progress value={percent} />
      <div className="flex items-center justify-between gap-2 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
        <span>{t("memory.modelDownloading", { progress: percent })}</span>
        {model.totalBytes ? <span>{formatBytes(model.loadedBytes ?? 0)} / {formatBytes(model.totalBytes)}</span> : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function RetentionSelect({ value, options, disabled, label, format, onChange }: { value: number; options: number[]; disabled: boolean; label: string; format: (value: number) => string; onChange: (value: number) => void }): JSX.Element {
  const values = [...new Set([...options, value])].sort((a, b) => a - b);
  const items = Object.fromEntries(values.map((option) => [String(option), format(option)]));
  return <Select value={String(value)} items={items} disabled={disabled} onValueChange={(next) => { if (next) onChange(Number(next)); }}>
    <SelectTrigger className="w-36" aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>{values.map((option) => <SelectItem key={option} value={String(option)}>{items[String(option)]}</SelectItem>)}</SelectContent>
  </Select>;
}
