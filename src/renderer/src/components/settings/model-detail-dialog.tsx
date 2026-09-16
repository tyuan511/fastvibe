import { useEffect, useState, type JSX, type ReactNode } from "react";
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
import { THINKING_LABELS } from "@/lib/thinking-levels";
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

const SOURCE_LABELS: Record<string, string> = {
  "models.dev": "models.dev",
  native: "引擎内置",
  default: "默认参数",
};

const MODALITY_KEYS = ["image", "video", "file"] as const;

/** Model without recorded levels: assume what the composer falls back to. */
const DEFAULT_EFFORTS = DEFAULT_THINKING_LEVELS;

/**
 * Everything the dialog can assert about a model: whether it reasons, and which inputs
 * it accepts. `reasoning` flips the `reasoning` flag; the modalities become `input`.
 * The engine only takes `text` and `image`, so the other two are recorded for the
 * roster rather than written to `models.json`.
 */
const TRAIT_DEFS = [
  { key: "reasoning", label: "推理" },
  { key: "image", label: "图片输入" },
  { key: "video", label: "视频输入" },
  { key: "file", label: "文件输入" },
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
  // A native provider's models live in the SDK registry and `models.json` is never
  // written for it, so its entry cannot carry an override — show it read-only rather
  // than accept edits the engine would discard.
  const editable = provider?.kind !== "native" && provider !== undefined;
  const model = target?.model;

  const [name, setName] = useState("");
  const [api, setApi] = useState<string>(INHERIT_API);
  const [context, setContext] = useState("");
  const [output, setOutput] = useState("");
  const [traits, setTraits] = useState<Set<TraitKey>>(new Set());
  const [levels, setLevels] = useState<Set<ThinkingLevel>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!model) return;
    setName(model.name ?? "");
    setApi(model.api ?? INHERIT_API);
    setContext(String(model.contextWindow ?? ""));
    setOutput(String(model.maxTokens ?? ""));
    setTraits(traitsOf(model));
    setLevels(new Set(model.thinkingLevels ?? DEFAULT_EFFORTS));
    setBusy(false);
    setError(null);
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
    if (key === "reasoning" && !on) setError(null);
  }

  async function submit(): Promise<void> {
    if (!model) return;
    const contextWindow = Number.parseInt(context.trim(), 10);
    const maxTokens = Number.parseInt(output.trim(), 10);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      setError("上下文窗口需为正整数");
      return;
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      setError("最大输出需为正整数");
      return;
    }
    if (reasoning && levels.size === 0) {
      setError("请至少勾选一个思考强度，或取消「推理」");
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
        ...(api === INHERIT_API ? { api: undefined } : { api: api as ProviderApi }),
      });
    } catch (err) {
      setBusy(false);
      setError(cleanError(err));
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>模型详情</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{model?.id ?? ""}</DialogDescription>
        </DialogHeader>

        {/* Scrolls only when the window is short, so the dialog never runs off screen. */}
        {model ? (
          <div className="max-h-[min(80vh,40rem)] space-y-3.5 overflow-y-auto">
            <Row label="显示名称">
              <Input
                value={name}
                disabled={!editable}
                placeholder={model.id}
                className="h-8 text-sm"
                onChange={(event) => setName(event.target.value)}
              />
            </Row>

            <Row label="协议">
              {editable ? (
                <Select
                  items={{
                    [INHERIT_API]: `跟随供应商（${apiLabel(provider?.api ?? "")}）`,
                    ...API_LABELS,
                  }}
                  value={api}
                  onValueChange={(value) => setApi(value ?? INHERIT_API)}
                >
                  <SelectTrigger size="sm" className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_API}>跟随供应商（{apiLabel(provider?.api ?? "")}）</SelectItem>
                    {PROVIDER_APIS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {API_LABELS[item]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <ReadValue>{apiLabel(provider?.api ?? "")}</ReadValue>
              )}
            </Row>

            <div className="grid grid-cols-2 gap-3">
              <Row label="上下文窗口">
                <Input
                  value={context}
                  disabled={!editable}
                  inputMode="numeric"
                  className="h-8 text-sm tabular-nums"
                  onChange={(event) => setContext(event.target.value)}
                />
              </Row>
              <Row label="最大输出">
                <Input
                  value={output}
                  disabled={!editable}
                  inputMode="numeric"
                  className="h-8 text-sm tabular-nums"
                  onChange={(event) => setOutput(event.target.value)}
                />
              </Row>
            </div>

            <Row label="支持特性">
              <div className="flex flex-wrap gap-x-4 gap-y-2 pt-0.5">
                {TRAIT_DEFS.map((item) => (
                  <CheckItem
                    key={item.key}
                    label={item.label}
                    checked={traits.has(item.key)}
                    disabled={!editable}
                    onToggle={(on) => toggleTrait(item.key, on)}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">推理与图片输入会写入引擎配置，视频、文件仅作记录。</p>
            </Row>

            <Row label="思考强度">
              <div className="flex flex-wrap gap-x-4 gap-y-2 pt-0.5">
                {THINKING_EFFORT_LEVELS.map((level) => (
                  <CheckItem
                    key={level}
                    label={THINKING_LABELS[level]}
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
                  勾选「推理」后可选择强度；不勾选则该模型不发送思考参数。
                </p>
              ) : null}
            </Row>

            <Row label="价格（每百万 tokens）">
              <Prices model={model} />
            </Row>

            <p className="text-xs text-muted-foreground">
              参数来源：{SOURCE_LABELS[model.source ?? ""] ?? "未知"}
            </p>
          </div>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {editable ? "取消" : "关闭"}
          </Button>
          {editable ? (
            <Button onClick={() => void submit()} disabled={busy}>
              保存
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
  const cost = model.cost;
  if (!cost) return <ReadValue>—</ReadValue>;
  return (
    <div className="space-y-2">
      <PriceTable label="每百万 tokens" cost={cost} first />
      {(model.costTiers ?? []).map((tier) => (
        <PriceTable key={tier.over} label={`超 ${contextLabel(tier.over)} 上下文`} cost={tier.cost} />
      ))}
    </div>
  );
}

function PriceTable({ label, cost, first }: { label: string; cost: ModelCost; first?: boolean }): JSX.Element {
  return (
    <div className="space-y-1 pt-1">
      <p className={cn("text-xs", first ? "text-foreground" : "text-warning")}>{label}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
        <PriceLine label="输入" value={cost.input} />
        <PriceLine label="输出" value={cost.output} />
        <PriceLine label="缓存读" value={cost.cacheRead} />
        <PriceLine label="缓存写" value={cost.cacheWrite} />
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
