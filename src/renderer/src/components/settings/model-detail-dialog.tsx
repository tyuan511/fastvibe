import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cleanError } from "@/lib/ipc-error";
import { thinkingLabel } from "@/lib/thinking-levels";
import { cn } from "@/lib/utils";
import {
  DEFAULT_THINKING_LEVELS,
  PROVIDER_APIS,
  THINKING_EFFORT_LEVELS,
  type ModelCost,
  type ProviderApi,
  type ProviderConfig,
  type ProviderModel,
  type ThinkingLevel,
} from "@shared/types";

/** Not an api: the model inherits whichever protocol its provider uses. */
const INHERIT_API = "inherit";

const API_LABELS: Record<ProviderApi, string> = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Messages",
  "google-generative-ai": "Gemini",
};

function sourceLabel(source: string): string {
  if (source === "native") return i18n.t("settings:modelDetail.engineBuiltin") as string;
  if (source === "default") return i18n.t("settings:modelDetail.defaultParams") as string;
  if (source === "models.dev") return "models.dev";
  return i18n.t("settings:modelDetail.unknown") as string;
}

const MODALITY_KEYS = ["image", "video", "file"] as const;

/** Model without recorded levels: assume what the composer falls back to. */
const DEFAULT_EFFORTS = DEFAULT_THINKING_LEVELS;

/**
 * Everything the dialog can assert about a model: whether it reasons, and which inputs
 * it accepts. `reasoning` flips the `reasoning` flag; the modalities become `input`.
 * The engine only takes `text` and `image`, so the other two are recorded for the
 * roster rather than written to the engine configuration.
 */
const TRAIT_DEFS = [
  { key: "reasoning", labelKey: "modelDetail.reasoning" },
  { key: "image", labelKey: "modelDetail.image" },
  { key: "video", labelKey: "modelDetail.video" },
  { key: "file", labelKey: "modelDetail.file" },
] as const;

type TraitKey = (typeof TRAIT_DEFS)[number]["key"];

export type ModelDetailTarget = { providerId: string; model: ProviderModel };

function apiLabel(api: string): string {
  return API_LABELS[api as ProviderApi] ?? api;
}

/** Read the model's reasoning flag and modalities into the checkbox set. */
function traitsOf(model: ProviderModel): Set<TraitKey> {
  const selected = new Set<TraitKey>();
  if (model.reasoning) selected.add("reasoning");
  for (const key of MODALITY_KEYS) {
    if (model.input.includes(key)) selected.add(key);
  }
  return selected;
}

export function ModelDetailDialog({
  target,
  provider,
  onClose,
  onSave,
}: {
  target: ModelDetailTarget | null;
  /** Owning provider — supplies the inherited protocol and the api-keyed fields. */
  provider: ProviderConfig | undefined;
  onClose: () => void;
  onSave: (next: ProviderModel) => Promise<void>;
}): JSX.Element {
  // Native models remain owned by the SDK, but Main persists the editable metadata as
  // a `models.json.modelOverrides` entry. Provider identity and protocol stay read-only
  // because they determine which native auth and streaming implementation is used.
  const { t } = useTranslation("settings");
  const editable = provider !== undefined;
  const protocolEditable = editable && provider?.kind !== "native";
  const model = target?.model;

  const [name, setName] = useState("");
  const [api, setApi] = useState<string>(INHERIT_API);
  const [context, setContext] = useState("");
  const [output, setOutput] = useState("");
  const [traits, setTraits] = useState<Set<TraitKey>>(new Set());
  const [levels, setLevels] = useState<Set<ThinkingLevel>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!model) return;
    setName(model.name ?? "");
    setApi(model.api ?? INHERIT_API);
    setContext(String(model.contextWindow ?? ""));
    setOutput(String(model.maxTokens ?? ""));
    setTraits(traitsOf(model));
    setLevels(new Set(model.thinkingLevels ?? DEFAULT_EFFORTS));
    setBusy(false);
  }, [model]);

  const reasoning = traits.has("reasoning");

  function toggleTrait(key: TraitKey, on: boolean): void {
    setTraits((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    // Levels are meaningless without reasoning; keep the selection for the moment the
    // user re-enables it, but the saved model drops them.
      }

  async function submit(): Promise<void> {
    if (!model) return;
    const contextWindow = Number.parseInt(context.trim(), 10);
    const maxTokens = Number.parseInt(output.trim(), 10);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      toast.error(t("modelDetail.contextInvalid"));
      return;
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      toast.error(t("modelDetail.outputInvalid"));
      return;
    }
    if (reasoning && levels.size === 0) {
      toast.error(t("modelDetail.needEffort"));
      return;
    }

    const input: string[] = ["text", ...MODALITY_KEYS.filter((key) => traits.has(key))];

    setBusy(true);
    try {
      await onSave({
        ...model,
        name: name.trim() || model.id,
        contextWindow,
        maxTokens,
        reasoning,
        input,
        thinkingLevels: reasoning ? THINKING_EFFORT_LEVELS.filter((level) => levels.has(level)) : undefined,
        edited: true,
        ...(protocolEditable
          ? (api === INHERIT_API ? { api: undefined } : { api: api as ProviderApi })
          : {}),
      });
    } catch (err) {
      setBusy(false);
      toast.error(cleanError(err));
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("modelDetail.title")}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{model?.id ?? ""}</DialogDescription>
        </DialogHeader>

        {/* Scrolls only when the window is short, so the dialog never runs off screen. */}
        {model ? (
          <div className="max-h-[min(80vh,40rem)] space-y-3.5 overflow-y-auto">
            <Row label={t("modelDetail.displayName")}>
              <Input
                value={name}
                disabled={!editable}
                placeholder={model.id}
                className="h-8 text-sm"
                onChange={(event) => setName(event.target.value)}
              />
            </Row>

            <Row label={t("modelDetail.protocol")}>
              {protocolEditable ? (
                <Select
                  items={{
                    [INHERIT_API]: t("modelDetail.followProvider", { api: apiLabel(provider?.api ?? "") }),
                    ...API_LABELS,
                  }}
                  value={api}
                  onValueChange={(value) => setApi(value ?? INHERIT_API)}
                >
                  <SelectTrigger size="sm" className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_API}>{t("modelDetail.followProvider", { api: apiLabel(provider?.api ?? "") })}</SelectItem>
                    {PROVIDER_APIS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {API_LABELS[item]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <ReadValue>{apiLabel(model.api ?? provider?.api ?? "")}</ReadValue>
              )}
            </Row>

            <div className="grid grid-cols-2 gap-3">
              <Row label={t("modelDetail.context")}>
                <Input
                  value={context}
                  disabled={!editable}
                  inputMode="numeric"
                  className="h-8 text-sm tabular-nums"
                  onChange={(event) => setContext(event.target.value)}
                />
              </Row>
              <Row label={t("modelDetail.maxOutput")}>
                <Input
                  value={output}
                  disabled={!editable}
                  inputMode="numeric"
                  className="h-8 text-sm tabular-nums"
                  onChange={(event) => setOutput(event.target.value)}
                />
              </Row>
            </div>

            <Row label={t("modelDetail.traits")}>
              <div className="flex flex-wrap gap-x-4 gap-y-2 pt-0.5">
                {TRAIT_DEFS.map((item) => (
                  <CheckItem
                    key={item.key}
                    label={t(item.labelKey)}
                    checked={traits.has(item.key)}
                    disabled={!editable}
                    onToggle={(on) => toggleTrait(item.key, on)}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("modelDetail.traitsHint")}</p>
            </Row>

            <Row label={t("modelDetail.thinking")}>
              <div className="flex flex-wrap gap-x-4 gap-y-2 pt-0.5">
                {THINKING_EFFORT_LEVELS.map((level) => (
                  <CheckItem
                    key={level}
                    label={thinkingLabel(level)}
                    checked={levels.has(level)}
                    disabled={!editable || !reasoning}
                    onToggle={(on) =>
                      setLevels((current) => {
                        const next = new Set(current);
                        if (on) next.add(level);
                        else next.delete(level);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
              {editable && !reasoning ? (
                <p className="text-xs text-muted-foreground">
                  {t("modelDetail.thinkingHint")}
                </p>
              ) : null}
            </Row>

            <Row label={t("modelDetail.price")}>
              <Prices model={model} />
            </Row>

            <p className="text-xs text-muted-foreground">
              {t("modelDetail.source", { source: sourceLabel(model.source ?? "") })}
            </p>
          </div>
        ) : null}


        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {editable ? t("modelDetail.cancel") : t("modelDetail.close")}
          </Button>
          {editable ? (
            <Button onClick={() => void submit()} disabled={busy}>
              {t("modelDetail.save")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ReadValue({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-8 items-center rounded-lg border border-dashed border-border px-3 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function CheckItem({
  label,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <Label className={cn("gap-1.5 text-xs font-normal", disabled && "text-muted-foreground")}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onToggle(value === true)} />
      {label}
    </Label>
  );
}

/**
 * Read-only prices; an absent record reads as "the catalog did not say". A model that
 * charges more past a context threshold lists its steps under the entry price, because
 * the number shown first is what most requests actually pay.
 */
function Prices({ model }: { model: ProviderModel }): JSX.Element {
  const { t } = useTranslation("settings");
  const cost = model.cost;
  if (!cost) return <ReadValue>—</ReadValue>;
  return (
    <div className="space-y-2">
      <PriceTable label={t("modelDetail.perMillion")} cost={cost} first />
      {(model.costTiers ?? []).map((tier) => (
        <PriceTable key={tier.over} label={t("modelDetail.overContext", { size: contextLabel(tier.over) })} cost={tier.cost} />
      ))}
    </div>
  );
}

function PriceTable({ label, cost, first }: { label: string; cost: ModelCost; first?: boolean }): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-1 pt-1">
      <p className={cn("text-xs", first ? "text-foreground" : "text-warning")}>{label}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
        <PriceLine label={t("modelDetail.input")} value={cost.input} />
        <PriceLine label={t("modelDetail.output")} value={cost.output} />
        <PriceLine label={t("modelDetail.cacheRead")} value={cost.cacheRead} />
        <PriceLine label={t("modelDetail.cacheWrite")} value={cost.cacheWrite} />
      </div>
    </div>
  );
}

function PriceLine({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(value === 0 && "text-muted-foreground")}>{formatPrice(value)}</span>
    </div>
  );
}

/** Prices span four orders of magnitude (0.05 to 450), so trim trailing zeros. */
function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  const digits = value < 1 ? 4 : 2;
  return `$${value.toFixed(digits).replace(/\.?0+$/, "")}`;
}

/** A threshold reads as `200K` / `1M`, matching how context windows are shown. */
function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1000)}K`;
}
