import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Ipc } from "@shared/ipc";
import type { DecisionKeyState, DecisionModelConfig, DecisionTestResult } from "@shared/decision";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { IS_REMOTE } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * 设置 → 决策引擎 (docs/decision-layer.md §5): which decision model browser use runs on.
 * Off keeps the `browser_*` tools the main model drives; Jev adds `browser_task`,
 * the per-step decision loop. The Jev key is written by Main and never read back — this
 * pane only learns whether one is stored.
 */
export function DecisionSettings() {
  const { t } = useTranslation("settings");
  const [saved, setSaved] = useState<DecisionModelConfig>({ kind: "off" });
  const [draft, setDraft] = useState<DecisionModelConfig>({ kind: "off" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testState, setTestState] = useState<{ pending: boolean; result?: DecisionTestResult }>({ pending: false });
  const [keys, setKeys] = useState<DecisionKeyState>({ jev: false });
  const [keyDraft, setKeyDraft] = useState("");
  const [keySaving, setKeySaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.fastvibe.decision.getConfig().then((config) => {
      if (cancelled) return;
      applyExternal(config);
      setLoading(false);
    });
    window.fastvibe.decision.keyState().then((state) => {
      if (!cancelled) setKeys(state);
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
    setError("");
    setTestState({ pending: false });
  }

  const kind = draft.kind;
  const next: DecisionModelConfig = kind === "jev" ? { kind: "jev" } : { kind: "off" };
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
    const result = await window.fastvibe.decision.test(next);
    setTestState({ pending: false, result });
  }

  async function saveKey(value: string) {
    if (blockedRemotely(Ipc.decisionSetKey)) return;
    setKeySaving(true);
    setError("");
    try {
      setKeys(await window.fastvibe.decision.setKey(value));
      setKeyDraft("");
      setTestState({ pending: false });
    } catch (cause) {
      setError(t("decision.saveFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setKeySaving(false);
    }
  }

  const models = { off: t("decision.off"), jev: t("decision.jev") };
  const hint = kind === "jev" ? t("decision.jevHint") : t("decision.offHint");

  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-muted-foreground">{t("decision.description")}</p>
      <SettingsGroup title={t("decision.title")}>
      <SettingsRow
        title={t("decision.model")}
        description={IS_REMOTE ? t("decision.remoteHint") : hint}
        control={
          <Select
            value={kind}
            items={models}
            disabled={loading || saving}
            onValueChange={(value) => {
              if (!value) return;
              setError("");
              setTestState({ pending: false });
              setDraft(value === "jev" ? { kind: "jev" } : { kind: "off" });
            }}
          >
            <SelectTrigger aria-label={t("decision.model")} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{models.off}</SelectItem>
              <SelectItem value="jev">{models.jev}</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {kind === "jev" && (
        <>
          <SettingsRow
            title={t("decision.apiKey")}
            description={keys.jev ? t("decision.keySaved") : t("decision.keyMissing")}
            control={
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  aria-label={t("decision.apiKey")}
                  className="w-44"
                  placeholder={keys.jev ? "••••••••" : t("decision.keyPlaceholder")}
                  value={keyDraft}
                  disabled={keySaving}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
                <Button size="sm" variant="outline" disabled={keySaving || !keyDraft.trim()} onClick={() => void saveKey(keyDraft)}>
                  {t("decision.keySave")}
                </Button>
                {keys.jev && (
                  <Button size="sm" variant="ghost" disabled={keySaving} onClick={() => void saveKey("")}>
                    {t("decision.keyClear")}
                  </Button>
                )}
              </div>
            }
          />
          <SettingsRow
            title={t("decision.test")}
            control={
              <div className="flex items-center gap-2">
                {testState.result &&
                  (testState.result.ok ? (
                    <span className="text-xs text-success">{t("decision.testOkNoModel")}</span>
                  ) : (
                    <span className="text-xs text-destructive">{t("decision.testFailed", { error: testState.result.error })}</span>
                  ))}
                <Button size="sm" variant="outline" disabled={!keys.jev || testState.pending} onClick={() => void test()}>
                  {t(testState.pending ? "decision.testing" : "decision.test")}
                </Button>
              </div>
            }
          />
          <p className="px-4 py-3 text-xs text-muted-foreground">{t("decision.jevPrivacy")}</p>
        </>
      )}
      <SettingsRow
        title={t("decision.apply")}
        control={
          <Button size="sm" variant="outline" disabled={saving || !dirty} onClick={() => void apply()}>
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
