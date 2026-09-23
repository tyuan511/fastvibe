import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { CircleQuestionMarkIcon } from "@hugeicons/core-free-icons";
import { Ipc } from "@shared/ipc";
import { decisionModelConfigOf, type DecisionKeyState, type DecisionModelConfig } from "@shared/decision";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { cleanError } from "@/lib/ipc-error";
import { IS_REMOTE } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsGroup, SettingsRow } from "./settings-group";

const EMPTY: DecisionModelConfig = { kind: "off", browserControl: false, computerControl: false };

/**
 * 设置 → 决策引擎 (docs/decision-layer.md §5): which decision model browser use runs on.
 * Off keeps the `browser_*` tools the main model drives. The engine select saves as soon
 * as it changes; Save belongs to 应用场景 alone, and Jev is offered `browser_task` only
 * after 浏览器控制 is checked and saved. With the engine off the scenarios are hidden.
 * A new Jev key is checked by Main before it is stored; this pane never reads it back.
 */
export function DecisionSettings() {
  const { t } = useTranslation("settings");
  const [saved, setSaved] = useState<DecisionModelConfig>(EMPTY);
  const [draft, setDraft] = useState<DecisionModelConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
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
    const next = decisionModelConfigOf(config);
    setSaved(next);
    setDraft(next);
    setError("");
  }

  const kind = draft.kind;
  const dirty = draft.browserControl !== saved.browserControl || draft.computerControl !== saved.computerControl;

  async function save(next: DecisionModelConfig) {
    if (blockedRemotely(Ipc.decisionSaveConfig)) return;
    setSaving(true);
    setError("");
    try {
      applyExternal(await window.fastvibe.decision.saveConfig(next));
      toast.success(t("decision.saved"));
    } catch (cause) {
      setError(t("decision.saveFailed", { error: cleanError(cause) }));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Switch the engine at once, with the scenarios as last *saved*: an unsaved tick in
   * 应用场景 stays a draft (still shown, still needing Save) rather than riding along.
   */
  async function saveKind(nextKind: DecisionModelConfig["kind"]) {
    if (blockedRemotely(Ipc.decisionSaveConfig)) return;
    const pending = { browserControl: draft.browserControl, computerControl: draft.computerControl };
    setSaving(true);
    setError("");
    try {
      const stored = decisionModelConfigOf(await window.fastvibe.decision.saveConfig({ ...saved, kind: nextKind }));
      setSaved(stored);
      setDraft({ ...stored, ...pending });
      toast.success(t("decision.saved"));
    } catch (cause) {
      setError(t("decision.saveFailed", { error: cleanError(cause) }));
    } finally {
      setSaving(false);
    }
  }

  async function saveKey(value: string) {
    if (blockedRemotely(Ipc.decisionSetKey)) return;
    setKeySaving(true);
    setError("");
    try {
      setKeys(await window.fastvibe.decision.setKey(value));
      setKeyDraft("");
      toast.success(t(value.trim() ? "decision.keyStored" : "decision.keyCleared"));
    } catch (cause) {
      setError(t("decision.saveFailed", { error: cleanError(cause) }));
    } finally {
      setKeySaving(false);
    }
  }

  const models = { off: t("decision.off"), jev: t("decision.jev") };
  const verifying = keySaving && Boolean(keyDraft.trim());

  return (
    <SettingsGroup>
      <SettingsRow
        title={t("decision.model")}
        description={IS_REMOTE ? t("decision.remoteHint") : undefined}
        control={
          <Select
            value={kind}
            items={models}
            disabled={loading || saving}
            onValueChange={(value) => {
              const next = value === "jev" ? "jev" : "off";
              if (!value || next === saved.kind) return;
              void saveKind(next);
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
        <SettingsRow
          title={
            <>
              <Label>{t("decision.apiKey")}</Label>
              <KeyHelp />
            </>
          }
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
                {t(verifying ? "decision.keyVerifying" : "decision.keySave")}
              </Button>
              {keys.jev && (
                <Button size="sm" variant="ghost" disabled={keySaving} onClick={() => void saveKey("")}>
                  {t("decision.keyClear")}
                </Button>
              )}
            </div>
          }
        />
      )}
      {kind === "jev" && (
        <SettingsRow
          align="start"
          title={t("decision.scenarios")}
          description={
            // The switches sit under the title so Save lines up with 应用场景 on the right,
            // rather than floating mid-way down a block of checkboxes.
            <span className="mt-2 flex flex-col items-start gap-2 text-sm text-foreground">
              <button
                type="button"
                className="flex items-center gap-2"
                disabled={loading || saving}
                onClick={() => setDraft((current) => ({ ...current, browserControl: !current.browserControl }))}
              >
                <Checkbox checked={draft.browserControl} className="pointer-events-none" />
                <span>{t("decision.browserControl")}</span>
              </button>
              <button
                type="button"
                className="flex items-center gap-2"
                disabled={loading || saving}
                onClick={() => setDraft((current) => ({ ...current, computerControl: !current.computerControl }))}
              >
                <Checkbox checked={draft.computerControl} className="pointer-events-none" />
                <span>{t("decision.computerControl")}</span>
              </button>
            </span>
          }
          control={
            <Button size="sm" variant="outline" disabled={saving || !dirty} onClick={() => void save(draft)}>
              {t(saving ? "decision.saving" : "decision.keySave")}
            </Button>
          }
        />
      )}
      {error && (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

function KeyHelp(): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={t("decision.keyHelp")}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <HugeiconsIcon strokeWidth={2} icon={CircleQuestionMarkIcon} className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80 whitespace-normal">
        <span>
          {t("decision.keyHelp")}{" "}
          <a
            href="https://console.typesafe.ai"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline underline-offset-3 hover:text-primary/80"
          >
            {t("decision.keyConsole")}
          </a>{" "}
          {t("decision.keySteps")}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
