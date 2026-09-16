import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  BoxesIcon,
  CpuIcon,
  Delete02Icon,
  Download01Icon,
  Loading03Icon,
  PencilEdit02Icon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { AppLogo } from "@/components/app-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cleanError } from "@/lib/ipc-error";
import { providerLabel } from "@/lib/provider-label";
import { cn } from "@/lib/utils";
import { PROVIDER_APIS, type CcSwitchCandidate, type CcSwitchScan, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { ModelDetailDialog, type ModelDetailTarget } from "./model-detail-dialog";
import { ModelPicker } from "./model-picker";

const PROVIDER_API_ITEMS: Record<ProviderApi, string> = {
  "openai-completions": "OpenAI Chat Completions (/chat/completions)",
  "openai-responses": "OpenAI Responses (/responses)",
  "anthropic-messages": "Anthropic Messages (/v1/messages)",
  "google-generative-ai": "Google Gemini (/v1beta)",
};

/** Short label for a model's pinned protocol, where the row is too narrow for the full one. */
const PROVIDER_API_SHORT: Record<ProviderApi, string> = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Messages",
  "google-generative-ai": "Gemini",
};

/** `native` = a pi-coding-agent built-in provider configured with an API key. */
type AddMode = "native" | "custom";

type AddState = {
  mode: AddMode;
  /** Chosen pi-coding-agent provider id when `mode === "native"`. */
  nativeId: string | null;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  candidates: ProviderModel[] | null;
  selected: Set<string>;
  busy: boolean;
  error: string | null;
};

type PickerState = {
  kind: "connect" | "models";
  providerId: string;
  apiKey?: string;
  candidates: ProviderModel[] | null;
  selected: Set<string>;
  busy: boolean;
  error: string | null;
};

const EMPTY_ADD: AddState = {
  mode: "native",
  nativeId: null,
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  candidates: null,
  selected: new Set(),
  busy: false,
  error: null,
};

export function ProvidersSettings({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [natives, setNatives] = useState<NativeProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [add, setAdd] = useState<AddState | null>(null);
  const [ccSwitchOpen, setCcSwitchOpen] = useState(false);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [detail, setDetail] = useState<ModelDetailTarget | null>(null);

  async function refresh(): Promise<ProviderConfig[]> {
    const next = await window.fastvibe.providers.list();
    setProviders(next);
    return next;
  }

  useEffect(() => {
    void Promise.all([refresh(), window.fastvibe.providers.native().then(setNatives)])
      .then(([next]) => {
        setSelectedId((current) => current ?? next.find((item) => item.kind === "builtin")?.id ?? next[0]?.id ?? null);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function mutate(action: () => Promise<ProviderConfig[]>): Promise<ProviderConfig[]> {
    const next = await action();
    setProviders(next);
    setError(null);
    onChanged();
    return next;
  }

  /**
   * Apply an edited model back into its provider. The whole model is replaced (not
   * merged) so clearing a protocol pin or a name is a real change, and the updated
   * provider is re-selected from the result.
   */
  async function saveDetail(next: ProviderModel): Promise<void> {
    const provider = providers.find((item) => item.id === detail?.providerId);
    if (!provider) throw new Error("供应商不存在");
    await mutate(() =>
      window.fastvibe.providers.update({
        id: provider.id,
        models: provider.models.map((item) => (item.id === next.id ? next : item)),
      }),
    );
    setDetail(null);
  }

  const builtin = providers.find((item) => item.kind === "builtin");
  const nativeProviders = providers.filter((item) => item.kind === "native");
  const customs = providers.filter((item) => item.kind === "custom");
  const selected = providers.find((item) => item.id === selectedId) ?? builtin ?? null;

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
        正在加载供应商…
      </div>
    );
  }

  return (
    <div className="flex min-h-80 overflow-hidden rounded-xl border border-border bg-card">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border">
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">
            {builtin ? (
              <div className="mb-3">
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">内置</p>
                <ProviderNavItem
                  provider={builtin}
                  selected={selected?.id === builtin.id}
                  onSelect={() => setSelectedId(builtin.id)}
                />
              </div>
            ) : null}
            {nativeProviders.length ? (
              <div className="mb-3">
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">供应商</p>
                <div className="space-y-0.5">
                  {nativeProviders.map((provider) => (
                    <ProviderNavItem
                      key={provider.id}
                      provider={provider}
                      selected={selected?.id === provider.id}
                      onSelect={() => setSelectedId(provider.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {customs.length ? (
              <div>
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">自定义供应商</p>
                <div className="space-y-0.5">
                  {customs.map((provider) => (
                    <ProviderNavItem
                      key={provider.id}
                      provider={provider}
                      selected={selected?.id === provider.id}
                      onSelect={() => setSelectedId(provider.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        <div className="shrink-0 space-y-0.5 border-t border-border p-2">
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted/60"
            onClick={() => setAdd({ ...EMPTY_ADD, selected: new Set() })}
          >
            <HugeiconsIcon strokeWidth={2} icon={Add01Icon} className="size-3.5" />
            添加供应商
          </button>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted/60"
            onClick={() => setCcSwitchOpen(true)}
          >
            <HugeiconsIcon strokeWidth={2} icon={Download01Icon} className="size-3.5" />
            从 CC Switch 导入
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1 p-5">
        {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
        {selected ? (
          <ProviderDetail
            provider={selected}
            onError={setError}
            onConnectFastVibe={(apiKey) => void startConnect(selected, apiKey, setPicker, setError)}
            onAddModels={() => void startAddModels(selected, setPicker, setError)}
            onEditModel={(model) => setDetail({ providerId: selected.id, model })}
            onChanged={async (next) => {
              setProviders(next);
              onChanged();
            }}
            onRemoved={async (next) => {
              setProviders(next);
              setSelectedId(builtin?.id ?? next[0]?.id ?? null);
              onChanged();
            }}
          />
        ) : (
          <p className="py-10 text-center text-xs text-muted-foreground">选择一个供应商</p>
        )}
      </div>

      <CcSwitchImportDialog
        open={ccSwitchOpen}
        onClose={() => setCcSwitchOpen(false)}
        onImported={async (next) => {
          setProviders(next);
          const created = next.filter((item) => item.kind !== "builtin").at(-1);
          if (created) setSelectedId(created.id);
          onChanged();
          setCcSwitchOpen(false);
        }}
      />

      <AddProviderDialog
        state={add}
        natives={natives}
        addedIds={providers.map((item) => item.id)}
        onPatch={(next) => setAdd((current) => (current ? { ...current, ...next } : current))}
        onClose={() => setAdd(null)}
        onFetch={() => void fetchAddCandidates(add, natives, setAdd)}
        onSave={() =>
          void saveAdd(add, setAdd, async (next) => {
            const saved = await mutate(async () => next);
            const created = saved.filter((item) => item.kind !== "builtin").at(-1);
            if (created) setSelectedId(created.id);
          })
        }
      />

      <ModelPickDialog
        state={picker}
        provider={providers.find((item) => item.id === picker?.providerId)}
        onPatch={(next) => setPicker((current) => (current ? { ...current, ...next } : current))}
        onClose={() => setPicker(null)}
        onSave={() => void savePicker(picker, providers, setPicker, mutate)}
      />

      <ModelDetailDialog
        target={detail}
        provider={providers.find((item) => item.id === detail?.providerId)}
        onClose={() => setDetail(null)}
        onSave={saveDetail}
      />
    </div>
  );
}

function ProviderNavItem({
  provider,
  selected,
  onSelect,
}: {
  provider: ProviderConfig;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm",
        selected ? "bg-muted font-medium" : "hover:bg-muted/60",
        !provider.enabled && "opacity-60",
      )}
      onClick={onSelect}
    >
      {provider.kind === "builtin" ? (
        <AppLogo className="size-4 shrink-0 rounded-[4px]" />
      ) : provider.kind === "native" ? (
        <HugeiconsIcon strokeWidth={2} icon={CpuIcon} className="size-3.5 text-muted-foreground" />
      ) : (
        <HugeiconsIcon strokeWidth={2} icon={BoxesIcon} className="size-3.5 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-left">{providerLabel(provider.name || provider.id)}</span>
      <span className={cn("size-1.5 shrink-0 rounded-full", provider.hasKey ? "bg-success" : "bg-muted-foreground/35")} />
    </button>
  );
}

function ProviderDetail({
  provider,
  onError,
  onConnectFastVibe,
  onAddModels,
  onEditModel,
  onChanged,
  onRemoved,
}: {
  provider: ProviderConfig;
  onError: (message: string | null) => void;
  onConnectFastVibe: (apiKey: string) => void;
  onAddModels: () => void;
  /** Opens 模型详情 for one entry of the model list. */
  onEditModel: (model: ProviderModel) => void;
  onChanged: (next: ProviderConfig[]) => Promise<void>;
  onRemoved: (next: ProviderConfig[]) => Promise<void>;
}): JSX.Element {
  const builtin = provider.kind === "builtin";
  const native = provider.kind === "native";
  /** Only custom providers own their identity and endpoint; the SDK owns native ones. */
  const editable = provider.kind === "custom";
  /** A native provider's model list is offline, so it needs no key to manage. */
  const canManageModels = native || provider.hasKey;
  const [name, setName] = useState(provider.name);
  const [editingName, setEditingName] = useState(false);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(provider.name);
    setEditingName(false);
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setShowKey(false);
  }, [provider.id, provider.name, provider.baseUrl]);

  async function save(patch: {
    name?: string;
    baseUrl?: string;
    api?: ProviderApi;
    enabled?: boolean;
    apiKey?: string;
    models?: ProviderModel[];
  }): Promise<void> {
    setSaving(true);
    try {
      await onChanged(await window.fastvibe.providers.update({ id: provider.id, ...patch }));
      onError(null);
      if (patch.apiKey !== undefined) setApiKey("");
    } catch (err) {
      onError(cleanError(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    try {
      await onRemoved(await window.fastvibe.providers.remove(provider.id));
    } catch (err) {
      onError(cleanError(err));
    }
  }

  async function removeModel(id: string): Promise<void> {
    await save({ models: provider.models.filter((item) => item.id !== id) });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {editingName && editable ? (
            <Input
              autoFocus
              value={name}
              className="h-8 max-w-56 text-sm font-medium"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                setEditingName(false);
                if (name.trim() && name.trim() !== provider.name) void save({ name: name.trim() });
                else setName(provider.name);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                if (event.key === "Escape") {
                  setName(provider.name);
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <h3 className="truncate text-base font-medium">{providerLabel(provider.name || provider.id)}</h3>
          )}
          {editable && !editingName ? (
            <Button size="icon-xs" variant="ghost" onClick={() => setEditingName(true)} aria-label="重命名">
              <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
            </Button>
          ) : null}
          {provider.enabled ? (
            <Badge variant="secondary" className="text-success">
              已启用
            </Badge>
          ) : (
            <Badge variant="outline">已禁用</Badge>
          )}
          <Button size="xs" variant="outline" disabled={saving} onClick={() => void save({ enabled: !provider.enabled })}>
            {provider.enabled ? "禁用" : "启用"}
          </Button>
        </div>
        {!builtin ? (
          <Button size="icon-xs" variant="ghost" onClick={() => void remove()} aria-label="删除供应商">
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </Button>
        ) : null}
      </div>

      {editable ? (
        <Field label="Base URL">
          <Input
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={() => {
              const next = baseUrl.trim().replace(/\/+$/, "");
              if (next && next !== provider.baseUrl) void save({ baseUrl: next });
              else setBaseUrl(provider.baseUrl);
            }}
          />
        </Field>
      ) : null}

      {native ? (
        <Field label="Base URL">
          <p className="flex h-8 items-center rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground">
            {provider.baseUrl}
          </p>
        </Field>
      ) : null}

      {native ? (
        <Field label="API 格式">
          <p className="flex h-8 items-center rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground">
            {provider.api}
          </p>
        </Field>
      ) : (
        <Field label="API 格式">
          <div className="space-y-1.5">
            {/* The builtin provider's protocol is the user's choice too; only an SDK
                built-in is pinned, because its api comes from the registry. */}
            <Select
              items={PROVIDER_API_ITEMS}
              value={provider.api}
              disabled={saving}
              onValueChange={(value) => {
                if (value) void save({ api: value as ProviderApi });
              }}
            >
              <SelectTrigger className="w-full max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_APIS.map((api) => (
                  <SelectItem key={api} value={api}>
                    {PROVIDER_API_ITEMS[api]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              供应商的默认协议；个别模型可在模型详情里单独指定。
            </p>
          </div>
        </Field>
      )}

      <Field label="API 密钥">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              type={showKey ? "text" : "password"}
              autoComplete="off"
              value={apiKey}
              placeholder={provider.hasKey ? "已保存，输入新密钥可更新" : "粘贴 API 密钥"}
              className="pr-8"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
              onClick={() => setShowKey((value) => !value)}
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
            >
              <HugeiconsIcon strokeWidth={2} icon={showKey ? ViewOffSlashIcon : ViewIcon} />
            </Button>
          </div>
          {builtin && !provider.hasKey ? (
            <Button disabled={!apiKey.trim() || saving} onClick={() => onConnectFastVibe(apiKey.trim())}>
              连接
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={!apiKey.trim() || saving}
              onClick={() => void save({ apiKey: apiKey.trim() })}
            >
              保存
            </Button>
          )}
        </div>
      </Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-normal text-muted-foreground">模型列表</Label>
          <div className="flex items-center gap-1">
            {canManageModels ? (
              <Button size="icon-xs" variant="ghost" onClick={onAddModels} aria-label="同步模型">
                <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
              </Button>
            ) : null}
          </div>
        </div>
        {provider.models.length ? (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {provider.models.map((model) => (
              <div key={model.id} className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm"
                  onClick={() => onEditModel(model)}
                >
                  {model.name || model.id}
                </button>
                {/* Only a pinned protocol is worth a chip; the inherited one is the norm. */}
                {model.api ? (
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    {PROVIDER_API_SHORT[model.api]}
                  </Badge>
                ) : null}
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {contextLabel(model.contextWindow)}
                </span>
                <Button size="icon-xs" variant="ghost" onClick={() => onEditModel(model)} aria-label="模型详情">
                  <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
                </Button>
                <Button size="icon-xs" variant="ghost" onClick={() => void removeModel(model.id)} aria-label="移除模型">
                  <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            {canManageModels ? "还没有模型，点击下方添加" : "连接后即可选择模型"}
          </p>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={builtin && !provider.hasKey ? !apiKey.trim() : !canManageModels}
          onClick={builtin && !provider.hasKey ? () => onConnectFastVibe(apiKey.trim()) : onAddModels}
        >
          <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
          添加模型
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function CcSwitchImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (next: ProviderConfig[]) => Promise<void>;
}): JSX.Element {
  const [scan, setScan] = useState<CcSwitchScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setScan(null);
    void window.fastvibe.providers
      .scanCcSwitch()
      .then((next) => {
        if (cancelled) return;
        setScan(next);
        setSelected(new Set(next.candidates.filter((item) => item.importable).map((item) => item.id)));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(cleanError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const importable = scan?.candidates.filter((item) => item.importable) ?? [];
  const chosen = importable.filter((item) => selected.has(item.id));

  function toggle(item: CcSwitchCandidate): void {
    if (!item.importable) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  async function importSelected(): Promise<void> {
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onImported(await window.fastvibe.providers.importCcSwitch(chosen.map((item) => item.id)));
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 CC Switch 导入</DialogTitle>
          <DialogDescription>
            读取 ~/.cc-switch 里带 API 密钥的供应商，写入 FastVibe。密钥不会显示在界面上。
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
            正在读取 CC Switch…
          </div>
        ) : !scan?.found ? (
          <p className="py-6 text-sm text-muted-foreground">
            未找到 CC Switch 数据库（{scan?.path || "~/.cc-switch/cc-switch.db"}）。
          </p>
        ) : scan.candidates.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            没有可导入的供应商。需要 CC Switch 里带 API 密钥的自定义供应商，官方登录项会跳过。
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {scan.candidates.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={!item.importable}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  item.importable ? "hover:bg-muted" : "opacity-55",
                  selected.has(item.id) && item.importable && "bg-muted",
                )}
                onClick={() => toggle(item)}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                    selected.has(item.id) && item.importable ? "border-primary bg-primary text-primary-foreground" : "border-input",
                  )}
                >
                  {selected.has(item.id) && item.importable ? (
                    <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 overflow-hidden">
                  <span className="block truncate text-sm">{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.appLabel}
                    {item.baseUrl ? ` · ${item.baseUrl.replace(/^https?:\/\//, "")}` : ""}
                    {item.modelCount ? ` · ${item.modelCount} 个模型` : ""}
                  </span>
                </span>
                {item.reason ? <span className="shrink-0 text-xs text-muted-foreground">{item.reason}</span> : null}
              </button>
            ))}
          </div>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || chosen.length === 0} onClick={() => void importSelected()}>
            {busy ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
            导入 {chosen.length > 0 ? chosen.length : ""} 个供应商
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddProviderDialog({
  state,
  natives,
  addedIds,
  onPatch,
  onClose,
  onFetch,
  onSave,
}: {
  state: AddState | null;
  natives: NativeProviderConfig[];
  addedIds: string[];
  onPatch: (next: Partial<AddState>) => void;
  onClose: () => void;
  onFetch: () => void;
  onSave: () => void;
}): JSX.Element {
  const native = state?.mode === "native";

  function setMode(mode: AddMode): void {
    // Switching source resets the picked provider and any fetched candidates.
    onPatch({ mode, nativeId: null, candidates: null, selected: new Set(), error: null });
  }

  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Width is fixed per view so switching source tabs never resizes the dialog. */}
      <DialogContent className={cn(state?.candidates ? "overflow-hidden sm:max-w-2xl" : "overflow-visible sm:max-w-md")}>
        <DialogHeader>
          <DialogTitle>{state?.candidates ? "选择模型" : "添加供应商"}</DialogTitle>
          <DialogDescription>
            {state?.candidates
              ? `已获取 ${state.candidates.length} 个模型，勾选后加入。`
              : native
                ? "选择一个内置供应商，并填入 API 密钥。"
                : "填写名称、地址和密钥。"}
          </DialogDescription>
        </DialogHeader>
        {state?.candidates ? (
          <ModelPicker
            models={state.candidates}
            selected={state.selected}
            onSelectedChange={(selected) => onPatch({ selected })}
          />
        ) : state ? (
          <div className="min-w-0 space-y-3">
            <div className="flex min-w-0 gap-1 rounded-lg bg-muted/60 p-1">
              {([
                ["native", "内置供应商"],
                ["custom", "自定义供应商"],
              ] as Array<[AddMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs",
                    state.mode === mode ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
                  )}
                  onClick={() => setMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            {native ? (
              <NativeProviderPicker
                providers={natives}
                addedIds={addedIds}
                value={state.nativeId}
                onSelect={(nativeId) => onPatch({ nativeId, error: null })}
              />
            ) : (
              <>
                <Field label="名称">
                  <Input autoFocus value={state.name} placeholder="例如 OpenRouter" onChange={(event) => onPatch({ name: event.target.value })} />
                </Field>
                <Field label="Base URL">
                  <Input
                    value={state.baseUrl}
                    placeholder={state.api === "google-generative-ai" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.example.com/v1"}
                    onChange={(event) => onPatch({ baseUrl: event.target.value })}
                  />
                </Field>
                <Field label="API 格式">
                  <Select items={PROVIDER_API_ITEMS} value={state.api} onValueChange={(value) => onPatch({ api: value as ProviderApi })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_APIS.map((api) => (
                        <SelectItem key={api} value={api}>
                          {PROVIDER_API_ITEMS[api]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </>
            )}
            <Field label="API 密钥">
              <Input
                type="password"
                autoComplete="off"
                value={state.apiKey}
                placeholder={native ? "粘贴该供应商的 API 密钥" : "sk-......"}
                onChange={(event) => onPatch({ apiKey: event.target.value })}
              />
            </Field>
          </div>
        ) : null}
        {state?.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
        <DialogFooter className="gap-2">
          {state?.candidates ? (
            <>
              <Button variant="outline" onClick={() => onPatch({ candidates: null })}>
                <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
                返回
              </Button>
              <Button onClick={onSave} disabled={state.busy || state.selected.size === 0}>
                {state.busy ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
                添加 {state.selected.size} 个模型
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={onFetch} disabled={state?.busy}>
                {state?.busy ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
                确认
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The pi-coding-agent built-in providers as a searchable dropdown. Their model
 * lists come from the SDK, so this is a local list — no request, no key — which
 * lets the user pick a provider and paste a key in either order.
 */
function NativeProviderPicker({
  providers,
  addedIds,
  value,
  onSelect,
}: {
  providers: NativeProviderConfig[];
  addedIds: string[];
  value: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? providers.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(q))
      : providers;
    // API-key providers first so OAuth/cloud ones don't occupy the top of an A–Z list.
    return [...matched].sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
  }, [providers, query]);
  const selected = providers.find((provider) => provider.id === value);

  function close(): void {
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current?.contains(event.target as Node)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <Field label="供应商">
      <div ref={rootRef} className="relative">
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          className="h-8 w-full min-w-0 justify-between px-2.5 font-normal"
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.name : "选择内置供应商"}
          </span>
          <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
        {open ? (
          <div className="absolute top-[calc(100%+0.375rem)] left-0 z-50 w-full rounded-lg bg-popover p-1 shadow-md ring-1 ring-foreground/10">
            <div className="relative mb-0.5 px-0.5 pt-0.5">
              <HugeiconsIcon
                strokeWidth={2}
                icon={Search01Icon}
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                value={query}
                placeholder="搜索内置供应商"
                className="h-7 rounded-md border-0 bg-transparent pl-6.5 text-sm shadow-none focus-visible:ring-0"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="max-h-52 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配的供应商</p>
              ) : (
                filtered.map((provider) => {
                  const added = addedIds.includes(provider.id);
                  const disabled = !provider.supported || added;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      disabled={disabled}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
                        disabled ? "opacity-55" : "hover:bg-muted",
                        value === provider.id && "bg-muted",
                      )}
                      onClick={() => {
                        onSelect(provider.id);
                        close();
                      }}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={CpuIcon} className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="block truncate text-sm">{provider.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {!provider.supported
                            ? provider.unsupportedReason
                            : added
                              ? "已添加"
                              : `${provider.models.length} 个模型`}
                        </span>
                      </span>
                      {value === provider.id ? (
                        <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5 shrink-0" />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : null}
      </div>
    </Field>
  );
}

function ModelPickDialog({
  state,
  provider,
  onPatch,
  onClose,
  onSave,
}: {
  state: PickerState | null;
  provider?: ProviderConfig;
  onPatch: (next: Partial<PickerState>) => void;
  onClose: () => void;
  onSave: () => void;
}): JSX.Element {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{state?.kind === "connect" ? "选择模型" : `管理模型 · ${providerLabel(provider?.name || provider?.id)}`}</DialogTitle>
          <DialogDescription>
            {state?.candidates ? `已拉取 ${state.candidates.length} 个模型，勾选后加入。` : "正在拉取模型列表…"}
          </DialogDescription>
        </DialogHeader>
        {state?.busy && !state.candidates ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
            正在拉取模型列表…
          </div>
        ) : state?.candidates ? (
          <ModelPicker
            models={state.candidates}
            selected={state.selected}
            onSelectedChange={(selected) => onPatch({ selected })}
          />
        ) : (
          <p className="text-xs text-destructive">{state?.error ?? "无法拉取模型列表"}</p>
        )}
        {state?.error && state.candidates ? <p className="text-xs text-destructive">{state.error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onSave} disabled={!state?.candidates || state.busy || state.selected.size === 0}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function startConnect(
  provider: ProviderConfig,
  apiKey: string,
  setPicker: (state: PickerState) => void,
  setError: (message: string | null) => void,
): Promise<void> {
  setPicker({
    kind: "connect",
    providerId: provider.id,
    apiKey,
    candidates: null,
    selected: new Set(),
    busy: true,
    error: null,
  });
  try {
    const models = await window.fastvibe.providers.fetch(provider.baseUrl, apiKey, provider.api);
    setPicker({
      kind: "connect",
      providerId: provider.id,
      apiKey,
      candidates: models,
      selected: new Set(models.map((item) => item.id)),
      busy: false,
      error: null,
    });
    setError(null);
  } catch (err) {
    setPicker({
      kind: "connect",
      providerId: provider.id,
      apiKey,
      candidates: null,
      selected: new Set(),
      busy: false,
      error: cleanError(err),
    });
  }
}

async function startAddModels(
  provider: ProviderConfig,
  setPicker: (state: PickerState) => void,
  setError: (message: string | null) => void,
): Promise<void> {
  setPicker({
    kind: "models",
    providerId: provider.id,
    candidates: null,
    selected: new Set(provider.models.map((item) => item.id)),
    busy: true,
    error: null,
  });
  try {
    const models = await window.fastvibe.providers.refresh(provider.id);
    const kept = new Set(provider.models.map((item) => item.id));
    setPicker({
      kind: "models",
      providerId: provider.id,
      candidates: models,
      selected: new Set(models.filter((item) => kept.has(item.id)).map((item) => item.id)),
      busy: false,
      error: null,
    });
    setError(null);
  } catch (err) {
    setPicker({
      kind: "models",
      providerId: provider.id,
      candidates: null,
      selected: new Set(),
      busy: false,
      error: cleanError(err),
    });
  }
}

async function fetchAddCandidates(
  add: AddState | null,
  natives: NativeProviderConfig[],
  setAdd: (value: AddState | ((current: AddState | null) => AddState | null)) => void,
): Promise<void> {
  if (!add) return;

  // Built-in providers already have their full model list bundled with the SDK,
  // so there is nothing to fetch — go straight to the picker.
  if (add.mode === "native") {
    const provider = natives.find((item) => item.id === add.nativeId);
    if (!provider) {
      setAdd({ ...add, error: "请选择一个内置供应商" });
      return;
    }
    if (!provider.supported) {
      setAdd({ ...add, error: provider.unsupportedReason ?? "该内置供应商暂不支持 API 密钥" });
      return;
    }
    if (!add.apiKey.trim()) {
      setAdd({ ...add, error: "请填写 API 密钥" });
      return;
    }
    setAdd({
      ...add,
      candidates: provider.models,
      selected: new Set(provider.models.map((item) => item.id)),
      busy: false,
      error: null,
    });
    return;
  }

  if (!add.name.trim() || !add.baseUrl.trim() || !add.apiKey.trim()) {
    setAdd({ ...add, error: "请填写名称、Base URL 与 API 密钥" });
    return;
  }
  setAdd({ ...add, busy: true, error: null });
  try {
    const models = await window.fastvibe.providers.fetch(add.baseUrl, add.apiKey, add.api);
    setAdd({
      ...add,
      candidates: models,
      selected: new Set(models.map((item) => item.id)),
      busy: false,
      error: null,
    });
  } catch (err) {
    setAdd({ ...add, busy: false, error: cleanError(err) });
  }
}

async function saveAdd(
  add: AddState | null,
  setAdd: (value: AddState | null) => void,
  onSaved: (next: ProviderConfig[]) => Promise<void>,
): Promise<void> {
  if (!add?.candidates) return;
  const models = add.candidates.filter((item) => add.selected.has(item.id));
  if (models.length === 0) {
    setAdd({ ...add, error: "至少选择一个模型" });
    return;
  }
  if (add.mode === "native" && !add.nativeId) {
    setAdd({ ...add, error: "请选择一个内置供应商" });
    return;
  }
  setAdd({ ...add, busy: true, error: null });
  try {
    const next =
      add.mode === "native"
        ? await window.fastvibe.providers.addNative({ id: add.nativeId!, apiKey: add.apiKey.trim(), models })
        : await window.fastvibe.providers.add({
          name: add.name.trim(),
          baseUrl: add.baseUrl.trim(),
          apiKey: add.apiKey.trim(),
          api: add.api,
          models,
        });
    setAdd(null);
    await onSaved(next);
  } catch (err) {
    setAdd({ ...add, busy: false, error: cleanError(err) });
  }
}

async function savePicker(
  picker: PickerState | null,
  providers: ProviderConfig[],
  setPicker: (value: PickerState | null | ((current: PickerState | null) => PickerState | null)) => void,
  mutate: (action: () => Promise<ProviderConfig[]>) => Promise<ProviderConfig[]>,
): Promise<void> {
  if (!picker?.candidates) return;
  const models = picker.candidates.filter((item) => picker.selected.has(item.id));
  const provider = providers.find((item) => item.id === picker.providerId);
  const existing = new Map((provider?.models ?? []).map((item) => [item.id, item]));
  const missing = (provider?.models ?? []).filter((item) => !picker.candidates!.some((candidate) => candidate.id === item.id));
  const nextModels = [...models, ...missing].map((model) => {
    const stored = existing.get(model.id);
    // A re-fetched model list has no memory of the per-model protocol pin, so carry
    // the stored override over instead of silently resetting the model to the
    // provider's api.
    if (!stored?.edited) return stored?.api ? { ...model, api: stored.api } : model;
    // A model tuned in 模型详情 keeps its choices; only the fetched metadata is refreshed.
    return {
      ...model,
      name: stored.name,
      contextWindow: stored.contextWindow,
      maxTokens: stored.maxTokens,
      reasoning: stored.reasoning,
      input: stored.input,
      thinkingLevels: stored.thinkingLevels,
      // Prices are not editable but they are metadata: a model id the catalog does not
      // know keeps the price it was stored with instead of losing it on the next sync.
      cost: stored.cost ?? model.cost,
      costTiers: stored.costTiers ?? model.costTiers,
      edited: true,
      ...(stored.api ? { api: stored.api } : {}),
    };
  });
  setPicker((current) => (current ? { ...current, busy: true, error: null } : current));
  try {
    if (picker.kind === "connect" && picker.apiKey) {
      await mutate(() => window.fastvibe.providers.saveFastVibe(picker.apiKey!, nextModels));
    } else {
      await mutate(() => window.fastvibe.providers.update({ id: picker.providerId, models: nextModels }));
    }
    setPicker(null);
  } catch (err) {
    setPicker((current) => (current ? { ...current, busy: false, error: cleanError(err) } : current));
  }
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1000)}K`;
}
