import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Ipc } from "@shared/ipc";
import { DEFAULT_LAYA_BASE_URL, validDecisionBaseUrl, type DecisionModelConfig, type DecisionTestResult } from "@shared/decision";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { IS_REMOTE } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * 设置 → 决策引擎: which local backend answers `state + questions → answers`
 * (docs/decision-layer.md §5.3). v1 offers only Laya — there is no Jev adapter yet, and
 * no consumer (browser-use, subagent routing, …) reads this config yet either; this pane
 * only persists the choice for one to use later.
 */
export function DecisionSettings() {
  const { t } = useTranslation("settings");
  const [saved, setSaved] = useState<DecisionModelConfig>({ kind: "off" });
  const [draft, setDraft] = useState<DecisionModelConfig>({ kind: "off" });
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testState, setTestState] = useState<{ pending: boolean; result?: DecisionTestResult }>({ pending: false });

  useEffect(() => {
    let cancelled = false;
    window.fastvibe.decision.getConfig().then((config) => {
      if (cancelled) return;
      applyExternal(config);
      setLoading(false);
    });
    const unsubscribe = window.fastvibe.decision.onChanged((config) => applyExternal(config));
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyExternal(config: DecisionModelConfig) {
    setSaved(config);
    setDraft(config);
    setBaseUrl(config.kind === "laya" ? (config.baseUrl ?? "") : "");
    setError("");
    setTestState({ pending: false });
  }

  const kind = draft.kind;
  const urlValid = baseUrl.trim() === "" || validDecisionBaseUrl(baseUrl.trim());
  const next: DecisionModelConfig =
    kind === "laya" ? { kind: "laya", ...(baseUrl.trim() && urlValid ? { baseUrl: baseUrl.trim() } : {}) } : { kind: "off" };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);

  async function apply() {
    if (blockedRemotely(Ipc.decisionSaveConfig)) return;
    setSaving(true);
    setError("");
    try {
      const result = await window.fastvibe.decision.saveConfig(next);
      applyExternal(result);
    } catch (cause) {
      setError(t("decision.saveFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (blockedRemotely(Ipc.decisionTest)) return;
    setTestState({ pending: true });
    const result = await window.fastvibe.decision.test(baseUrl.trim() || undefined);
    setTestState({ pending: false, result });
  }

  const models = { off: t("decision.off"), laya: t("decision.laya") };

  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-muted-foreground">{t("decision.description")}</p>
      <SettingsGroup title={t("decision.title")}>
      <SettingsRow
        title={t("decision.model")}
        description={kind === "laya" ? t("decision.layaHint") : IS_REMOTE ? t("decision.remoteHint") : undefined}
        control={
          <Select
            value={kind}
            items={models}
            disabled={loading || saving}
            onValueChange={(value) => {
              if (!value) return;
              setError("");
              setDraft(value === "laya" ? { kind: "laya", baseUrl: saved.kind === "laya" ? saved.baseUrl : undefined } : { kind: "off" });
            }}
          >
            <SelectTrigger aria-label={t("decision.model")} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{models.off}</SelectItem>
              <SelectItem value="laya">{models.laya}</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {kind === "laya" && (
        <>
          <SettingsRow
            title={t("decision.baseUrl")}
            description={!urlValid ? t("decision.invalidBaseUrl") : t("decision.baseUrlHint")}
            control={
              <Input
                aria-label={t("decision.baseUrl")}
                aria-invalid={!urlValid}
                className="w-56"
                placeholder={DEFAULT_LAYA_BASE_URL}
                value={baseUrl}
                disabled={saving}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setTestState({ pending: false });
                }}
              />
            }
          />
          <SettingsRow
            title={t("decision.test")}
            control={
              <div className="flex items-center gap-2">
                {testState.result &&
                  (testState.result.ok ? (
                    <span className="text-xs text-success">
                      {testState.result.model ? t("decision.testOk", { model: testState.result.model }) : t("decision.testOkNoModel")}
                    </span>
                  ) : (
                    <span className="text-xs text-destructive">{t("decision.testFailed", { error: testState.result.error })}</span>
                  ))}
                <Button size="sm" variant="outline" disabled={!urlValid || testState.pending} onClick={() => void test()}>
                  {t(testState.pending ? "decision.testing" : "decision.test")}
                </Button>
              </div>
            }
          />
        </>
      )}
      <SettingsRow
        title={t("decision.apply")}
        control={
          <Button size="sm" variant="outline" disabled={saving || !dirty || !urlValid} onClick={() => void apply()}>
            {t(saving ? "decision.saving" : "decision.apply")}
          </Button>
        }
      />
      {error && (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      )}
      </SettingsGroup>
    </div>
  );
}
