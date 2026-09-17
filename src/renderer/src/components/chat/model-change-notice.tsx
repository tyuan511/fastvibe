import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { EngineModel, FastVibeModel } from "@shared/types";
import { providerLabel } from "@/lib/provider-label";
import { useSessionStore } from "@/stores/session";

/**
 * `provider/model`, in the same shape the composer's chip shows. The catalog is only
 * consulted for the provider's display name: a model that was since unconfigured still
 * has to render (a switch should stay legible after its provider was removed).
 */
function label(model: EngineModel | undefined, models: FastVibeModel[]): string {
  if (!model) return "";
  const known = models.find((item) => item.provider === model.provider && item.id === model.id);
  return `${known?.providerName || providerLabel(model.provider)}/${model.id}`;
}

/**
 * The transcript's model divider — one quiet rule saying which model the turns from
 * here on run on. It is a part, not a row of its own: a switch made while a reply was
 * streaming belongs *inside* that reply (see `MessagePart`), so it is drawn between
 * two of the reply's blocks rather than between turns.
 *
 * It names the model the reply runs on rather than the pair it moved between: the
 * divider is drawn where the new model starts answering, and which model that is is
 * the only thing the reader needs from it (the previous one was already on the chip).
 */
export function ModelChangeNotice({ to }: { to: EngineModel }): JSX.Element {
  const { t } = useTranslation("chat");
  const models = useSessionStore((state) => state.models);
  const current = label(to, models);
  return (
    <div className="flex w-full items-center gap-3 py-1 text-xs text-muted-foreground/60">
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">{t("model.switched")}</span>
        <span className="max-w-40 truncate font-medium text-muted-foreground/80">{current}</span>
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}
