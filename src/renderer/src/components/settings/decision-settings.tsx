import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Ipc } from "@shared/ipc";
import { DECISION_SCENARIOS, DEFAULT_DECISION_MODEL, decisionModelConfigOf, type DecisionModelConfig, type DecisionModelRef, type DecisionScenario } from "@shared/decision";
import type { ProviderConfig } from "@shared/types";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { cleanError } from "@/lib/ipc-error";
import { IS_REMOTE } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsGroup, SettingsRow } from "./settings-group";

const EMPTY: DecisionModelConfig = DEFAULT_DECISION_MODEL;

function scenariosOf(config: DecisionModelConfig): Record<DecisionScenario, boolean> {
  return Object.fromEntries(DECISION_SCENARIOS.map((key) => [key, config[key]])) as Record<DecisionScenario, boolean>;
}

/**
 * 设置 → 决策引擎 (docs/decision-layer.md §5): which decision model runs, and for what.
 * Off keeps every scenario on its default path. The engine select saves as soon as it
 * changes; Save belongs to 应用场景 alone, and each scenario starts only once its box is
 * checked and saved. With the engine off the scenarios are hidden.
 * A new Jev key is checked by Main before it is stored; this pane never reads it back.
 */
export function DecisionSettings() {
  const { t } = useTranslation("settings");
  const [saved, setSaved] = useState<DecisionModelConfig>(EMPTY);
  const [draft, setDraft] = useState<DecisionModelConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.fastvibe.decision.getConfig().then((config) => {
      if (cancelled) return;
      applyExternal(config);
      setLoading(false);
    });
    window.fastvibe.providers.list().then((list) => {
      if (!cancelled) setProviders(list);
    }).catch(() => undefined);
    const unsubscribe = window.fastvibe.decision.onChanged((config) => applyExternal(config));
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyExternal(config: DecisionModelConfig) {
    const next = decisionModelConfigOf(config);
    setSaved(next);
    setDraft(next);
  }

  const dirty = DECISION_SCENARIOS.some((key) => draft[key] !== saved[key]);

  async function save(next: DecisionModelConfig) {
    if (blockedRemotely(Ipc.decisionSaveConfig)) return;
    setSaving(true);
    try {
      applyExternal(await window.fastvibe.decision.saveConfig(next));
      toast.success(t("decision.saved"));
    } catch (cause) {
      toast.error(t("decision.saveFailed", { error: cleanError(cause) }));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Switch the engine at once, with the scenarios as last *saved*: an unsaved tick in
   * 应用场景 stays a draft (still shown, still needing Save) rather than riding along.
   */
  async function saveSelection(value: string) {
    if (blockedRemotely(Ipc.decisionSaveConfig)) return;
    const pending = scenariosOf(draft);
    const model = value === "off" ? undefined : modelFromValue(value);
    if (value !== "off" && !model) return;
    setSaving(true);
    try {
      const stored = decisionModelConfigOf(await window.fastvibe.decision.saveConfig({
        ...saved,
        kind: model ? "jev" : "off",
        ...(model ? { model } : { model: undefined }),
      }));
      setSaved(stored);
      setDraft({ ...stored, ...pending });
      toast.success(t("decision.saved"));
    } catch (cause) {
      toast.error(t("decision.saveFailed", { error: cleanError(cause) }));
    } finally {
      setSaving(false);
    }
  }

  const choices = systemOneChoices(providers);
  const selected = draft.kind === "jev" && draft.model && choices.some((item) => item.provider.id === draft.model?.provider && item.model.id === draft.model?.id)
    ? optionValue(draft.model)
    : "off";
  const items: Record<string, string> = { off: t("decision.off") };
  for (const choice of choices) items[optionValue(choice)] = `${choice.provider.name} / ${choice.model.name || choice.model.id}`;

  return (
    <SettingsGroup>
      <SettingsRow
        title={t("decision.model")}
        description={IS_REMOTE ? t("decision.remoteHint") : choices.length === 0 ? t("decision.noSystemOne") : undefined}
        control={
          <Select
            value={selected}
            items={items}
            disabled={loading || saving}
            onValueChange={(value) => {
              if (!value || value === selected) return;
              void saveSelection(value);
            }}
          >
            <SelectTrigger aria-label={t("decision.model")} className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("decision.off")}</SelectItem>
              {groupChoices(choices).map((group) => (
                <SelectGroup key={group.provider.id}>
                  <SelectLabel>{group.provider.name}</SelectLabel>
                  {group.models.map((model) => (
                    <SelectItem key={optionValue({ provider: group.provider, model })} value={optionValue({ provider: group.provider, model })}>
                      {model.name || model.id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {draft.kind === "jev" && draft.model && (
        <SettingsRow
          align="start"
          title={t("decision.scenarios")}
          description={
            // The switches sit under the title so Save lines up with 应用场景 on the right,
            // rather than floating mid-way down a block of checkboxes.
            <span className="mt-2 flex flex-col items-start gap-2.5 text-sm text-foreground">
              {DECISION_SCENARIOS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="flex items-start gap-2 text-left"
                  disabled={loading || saving}
                  onClick={() => setDraft((current) => ({ ...current, [key]: !current[key] }))}
                >
                  <Checkbox checked={draft[key] === true} className="pointer-events-none mt-0.5" />
                  <span className="flex flex-col gap-0.5">
                    <span>{t(`decision.${key}`)}</span>
                    <span className="text-xs text-muted-foreground">{t(`decision.${key}Hint`)}</span>
                  </span>
                </button>
              ))}
            </span>
          }
          control={
            <Button size="sm" variant="outline" disabled={saving || !dirty} onClick={() => void save(draft)}>
              {t(saving ? "decision.saving" : "decision.keySave")}
            </Button>
          }
        />
      )}
    </SettingsGroup>
  );
}

type SystemOneChoice = { provider: ProviderConfig; model: ProviderConfig["models"][number] };

function systemOneChoices(providers: ProviderConfig[]): SystemOneChoice[] {
  return providers.flatMap((provider) =>
    provider.enabled
      ? provider.models
          .filter((model) => (model.api ?? provider.api) === "systemone")
          .map((model) => ({ provider, model }))
      : [],
  );
}

function groupChoices(choices: SystemOneChoice[]): Array<{ provider: ProviderConfig; models: ProviderConfig["models"] }> {
  const groups: Array<{ provider: ProviderConfig; models: ProviderConfig["models"] }> = [];
  for (const choice of choices) {
    const group = groups.find((item) => item.provider.id === choice.provider.id);
    if (group) group.models.push(choice.model);
    else groups.push({ provider: choice.provider, models: [choice.model] });
  }
  return groups;
}

function optionValue(ref: DecisionModelRef | SystemOneChoice): string {
  return "model" in ref ? `${ref.provider.id}\t${ref.model.id}` : `${ref.provider}\t${ref.id}`;
}

function modelFromValue(value: string): DecisionModelRef | undefined {
  const [provider, id] = value.split("\t");
  if (!provider || !id) return undefined;
  return { provider, id };
}
