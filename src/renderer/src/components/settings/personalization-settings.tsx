import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSettingsStore } from "@/stores/settings";

/** Settings for the user-authored suffix of every conversation's system prompt. */
export function PersonalizationSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const savedPrompt = useSettingsStore((state) => state.settings.customSystemPrompt);
  const update = useSettingsStore((state) => state.update);
  const [draft, setDraft] = useState(savedPrompt);

  useEffect(() => {
    setDraft(savedPrompt);
  }, [savedPrompt]);

  const dirty = draft !== savedPrompt;

  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t("personalization.promptTitle")}</h3>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t("personalization.promptDesc")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!dirty}
          onClick={() => update({ customSystemPrompt: draft })}
        >
          {t("personalization.save")}
        </Button>
      </div>
      <Textarea
        aria-label={t("personalization.promptTitle")}
        className="min-h-72 resize-y bg-card text-sm leading-6"
        placeholder={t("personalization.placeholder")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t("personalization.promptHint")}</p>
    </section>
  );
}
