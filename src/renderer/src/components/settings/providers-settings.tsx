import { useEffect, useState, type JSX } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react";
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
import type { ProviderConfig, ProviderModel } from "@shared/types";
import { ModelEditor } from "./model-editor";
import { ModelPicker, inputSummary } from "./model-picker";

type ConnectState = {
  mode: "fastvibe" | "add";
  name: string;
  baseUrl: string;
  apiKey: string;
  candidates: ProviderModel[] | null;
  selected: Set<string>;
  busy: boolean;
  error: string | null;
};

type ManageState = {
  providerId: string;
  providerName: string;
  candidates: ProviderModel[] | null;
  selected: Set<string>;
  busy: boolean;
  error: string | null;
};

export function ProvidersSettings({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [manage, setManage] = useState<ManageState | null>(null);
  const [editing, setEditing] = useState<{ providerId: string; model: ProviderModel } | null>(null);

  async function refresh(): Promise<void> {
    setProviders(await window.fastvibe.providers.list());
  }

  useEffect(() => {
    void refresh()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function mutate(action: () => Promise<ProviderConfig[]>): Promise<void> {
    try {
      setProviders(await action());
      setError(null);
      onChanged();
    } catch (err) {
      setError(cleanError(err));
    }
  }

  /* ---------- connect (fastvibe / add custom) ---------- */

  function openFastVibe(): void {
    const fastvibe = providers.find((provider) => provider.kind === "builtin");
    setConnect({
      mode: "fastvibe",
      name: "FastVibe",
      baseUrl: fastvibe?.baseUrl ?? "",
      apiKey: "",
      candidates: null,
      selected: new Set(),
      busy: false,
      error: null,
    });
  }

  function openAdd(): void {
    setConnect({
      mode: "add",
      name: "",
      baseUrl: "",
      apiKey: "",
      candidates: null,
      selected: new Set(),
      busy: false,
      error: null,
    });
  }

  function patchConnect(next: Partial<ConnectState>): void {
    setConnect((current) => (current ? { ...current, ...next } : current));
  }

  async function fetchCandidates(): Promise<void> {
    if (!connect) return;
    if (!connect.baseUrl.trim() || !connect.apiKey.trim()) {
      patchConnect({ error: "请填写 Base URL 与 API 密钥" });
      return;
    }
    patchConnect({ busy: true, error: null });
    try {
      const models = await window.fastvibe.providers.fetch(connect.baseUrl, connect.apiKey);
      patchConnect({
        candidates: models,
        selected: new Set(models.map((model) => model.id)),
        busy: false,
      });
    } catch (err) {
      patchConnect({ busy: false, error: cleanError(err) });
    }
  }

  async function saveConnect(): Promise<void> {
    if (!connect?.candidates) return;
    const models = connect.candidates.filter((model) => connect.selected.has(model.id));
    if (models.length === 0) {
      patchConnect({ error: "至少选择一个模型" });
      return;
    }
    patchConnect({ busy: true, error: null });
    try {
      if (connect.mode === "fastvibe") {
        await window.fastvibe.providers.saveFastVibe(connect.apiKey.trim(), models);
      } else {
        await window.fastvibe.providers.add({
          name: connect.name.trim(),
          baseUrl: connect.baseUrl.trim(),
          apiKey: connect.apiKey.trim(),
          models,
        });
      }
      setConnect(null);
      await refresh();
      onChanged();
    } catch (err) {
      patchConnect({ busy: false, error: cleanError(err) });
    }
  }

  /* ---------- manage existing provider models ---------- */

  async function openManage(provider: ProviderConfig): Promise<void> {
    setManage({
      providerId: provider.id,
      providerName: provider.name,
      candidates: null,
      selected: new Set(provider.models.map((model) => model.id)),
      busy: true,
      error: null,
    });
    try {
      const models = await window.fastvibe.providers.refresh(provider.id);
      const providerIds = new Set(provider.models.map((model) => model.id));
      setManage((current) =>
        current && current.providerId === provider.id
          ? {
              ...current,
              candidates: models,
              selected: new Set(
                models.filter((model) => providerIds.has(model.id)).map((model) => model.id),
              ),
              busy: false,
            }
          : current,
      );
    } catch (err) {
      setManage((current) =>
        current && current.providerId === provider.id
          ? { ...current, busy: false, error: cleanError(err) }
          : current,
      );
    }
  }

  async function saveManage(): Promise<void> {
    if (!manage?.candidates) return;
    const models = manage.candidates.filter((model) => manage.selected.has(model.id));
    // keep any model the provider already had even if the API no longer lists it
    const provider = providers.find((item) => item.id === manage.providerId);
    const missing = (provider?.models ?? []).filter(
      (model) => !manage.candidates!.some((candidate) => candidate.id === model.id),
    );
    setManage(null);
    await mutate(() =>
      window.fastvibe.providers.update({ id: manage.providerId, models: [...models, ...missing] }),
    );
  }

  async function removeModel(provider: ProviderConfig, modelId: string): Promise<void> {
    await mutate(() =>
      window.fastvibe.providers.update({
        id: provider.id,
        models: provider.models.filter((model) => model.id !== modelId),
      }),
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在加载供应商…
      </div>
    );
  }

  const fastvibe = providers.find((provider) => provider.kind === "builtin");
  const customs = providers.filter((provider) => provider.kind === "custom");

  return (
    <div className="space-y-4">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {fastvibe ? (
        <ProviderCard
          provider={fastvibe}
          pinned
          onConnect={openFastVibe}
          onManage={() => void openManage(fastvibe)}
          onEditModel={(model) => setEditing({ providerId: fastvibe.id, model })}
          onRemoveModel={(modelId) => void removeModel(fastvibe, modelId)}
        />
      ) : null}

      <div className="flex items-center justify-between pt-1">
        <span className="text-[12.5px] font-medium text-muted-foreground">自定义供应商</span>
        <Button size="xs" variant="outline" onClick={openAdd}>
          <Plus />
          添加供应商
        </Button>
      </div>

      {customs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
          还没有自定义供应商。添加后会自动拉取模型列表。
        </p>
      ) : (
        customs.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onConnect={openFastVibe}
            onManage={() => void openManage(provider)}
            onEditModel={(model) => setEditing({ providerId: provider.id, model })}
            onRemoveModel={(modelId) => void removeModel(provider, modelId)}
            onRemove={() => void mutate(() => window.fastvibe.providers.remove(provider.id))}
          />
        ))
      )}

      <ConnectDialog
        state={connect}
        onPatch={patchConnect}
        onClose={() => setConnect(null)}
        onFetch={() => void fetchCandidates()}
        onSave={() => void saveConnect()}
      />

      <Dialog open={manage !== null} onOpenChange={(open) => !open && setManage(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>管理模型 · {manage?.providerName}</DialogTitle>
            <DialogDescription>勾选要保留的模型。</DialogDescription>
          </DialogHeader>
          {manage?.busy && !manage.candidates ? (
            <div className="flex items-center gap-2 py-10 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在拉取模型列表…
            </div>
          ) : manage?.candidates ? (
            <ModelPicker
              models={manage.candidates}
              selected={manage.selected}
              onSelectedChange={(selected) =>
                setManage((current) => (current ? { ...current, selected } : current))
              }
            />
          ) : (
            <p className="text-xs text-destructive">{manage?.error ?? "无法拉取模型列表"}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setManage(null)}>
              取消
            </Button>
            <Button onClick={() => void saveManage()} disabled={!manage?.candidates || manage.busy}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ModelEditor
        model={editing?.model ?? null}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={(model) => {
          if (!editing) return;
          const provider = providers.find((item) => item.id === editing.providerId);
          if (!provider) return;
          void mutate(() =>
            window.fastvibe.providers.update({
              id: provider.id,
              models: provider.models.map((item) => (item.id === model.id ? model : item)),
            }),
          );
        }}
      />
    </div>
  );
}

function ProviderCard({
  provider,
  pinned,
  onConnect,
  onManage,
  onEditModel,
  onRemoveModel,
  onRemove,
}: {
  provider: ProviderConfig;
  pinned?: boolean;
  onConnect: () => void;
  onManage: () => void;
  onEditModel: (model: ProviderModel) => void;
  onRemoveModel: (modelId: string) => void;
  onRemove?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(pinned);

  return (
    <div
      className={`overflow-hidden rounded-xl border p-3 ${pinned ? "border-primary/40 bg-primary/5" : "border-border"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {pinned ? <Star className="size-3.5 text-primary" /> : null}
            <span className="truncate text-[13px] font-semibold">{provider.name}</span>
            {pinned ? <Badge variant="secondary">内置</Badge> : null}
            {provider.hasKey ? (
              <Badge variant="outline" className="gap-1 text-emerald-700">
                <Check className="size-3" />
                已连接
              </Badge>
            ) : (
              <Badge variant="outline">未配置</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{provider.baseUrl}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{provider.models.length} 个模型</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant={provider.hasKey ? "outline" : "default"} onClick={onConnect}>
            {provider.hasKey ? "更新密钥" : "连接"}
          </Button>
          {provider.hasKey ? (
            <Button size="xs" variant="outline" onClick={onManage}>
              <RefreshCw />
              模型
            </Button>
          ) : null}
          {onRemove ? (
            <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label="删除供应商">
              <Trash2 />
            </Button>
          ) : null}
          {provider.models.length > 0 ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => setOpen((value) => !value)}
              aria-label="展开模型"
            >
              <ChevronDown className={open ? "rotate-180 transition-transform" : "transition-transform"} />
            </Button>
          ) : null}
        </div>
      </div>

      {open && provider.models.length > 0 ? (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-background">
          <div className="divide-y divide-border">
            {provider.models.map((model) => (
              <div key={model.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{model.name || model.id}</span>
                  <span className="block truncate text-[10.5px] text-muted-foreground">
                    {inputSummary(model)} · {Math.round(model.contextWindow / 1000)}K
                    {model.reasoning ? ` · 推理 ${(model.thinkingLevels ?? []).length || 0} 档` : ""}
                  </span>
                </span>
                <Button size="icon-xs" variant="ghost" onClick={() => onEditModel(model)} aria-label="编辑">
                  <Pencil />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onRemoveModel(model.id)}
                  aria-label="移除"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectDialog({
  state,
  onPatch,
  onClose,
  onFetch,
  onSave,
}: {
  state: ConnectState | null;
  onPatch: (next: Partial<ConnectState>) => void;
  onClose: () => void;
  onFetch: () => void;
  onSave: () => void;
}): JSX.Element {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {state?.mode === "fastvibe"
              ? "FastVibe"
              : state?.candidates
                ? "选择模型"
                : "添加供应商"}
          </DialogTitle>
          <DialogDescription>
            {state?.candidates
              ? `已拉取 ${state.candidates.length} 个模型，勾选后加入。`
              : "填写供应商信息后拉取全量模型列表。"}
          </DialogDescription>
        </DialogHeader>

        {state?.candidates ? (
          <ModelPicker
            models={state.candidates}
            selected={state.selected}
            onSelectedChange={(selected) => onPatch({ selected })}
          />
        ) : (
          <div className="space-y-3">
            {state?.mode === "add" ? (
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">名称</span>
                <Input
                  value={state.name}
                  placeholder="例如 OpenRouter"
                  onChange={(event) => onPatch({ name: event.target.value })}
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Base URL</span>
              <Input
                value={state?.baseUrl ?? ""}
                placeholder="https://api.example.com/v1"
                onChange={(event) => onPatch({ baseUrl: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">API 密钥</span>
              <Input
                type="password"
                autoComplete="off"
                value={state?.apiKey ?? ""}
                onChange={(event) => onPatch({ apiKey: event.target.value })}
              />
            </div>
          </div>
        )}

        {state?.error ? <p className="text-xs text-destructive">{state.error}</p> : null}

        <DialogFooter className="gap-2">
          {state?.candidates ? (
            <>
              <Button variant="outline" onClick={() => onPatch({ candidates: null })}>
                <ArrowLeft />
                返回
              </Button>
              <Button onClick={onSave} disabled={state.busy || state.selected.size === 0}>
                {state.busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                添加 {state.selected.size} 个模型
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={onFetch} disabled={state?.busy}>
                {state?.busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                拉取模型列表
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "操作失败，请重试";
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "");
}
