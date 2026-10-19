import { useEffect, useMemo, useState, type HTMLAttributes, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  RefreshIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
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
import { cn } from "@/lib/utils";
import { PROVIDER_APIS, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { OAuthExtraUsageNote } from "./oauth-extra-usage-note";
import { PROVIDER_API_ITEMS, PROVIDER_API_SHORT } from "./providers-settings-types";
import { OpenAIQuota } from "./openai-quota";
import { ProviderTest } from "./provider-test";
import {
  orderProviderModels,
  providerModelLabel,
} from "@shared/model-order";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Field } from "./provider-field";
import { GatewayBalance } from "./gateway-balance";
import { gatewayRowState } from "@/lib/gateway-row";

function ProviderModelRow({
  model,
  onEdit,
  onRemove,
  reorderLabel,
  dragProps,
  testControl,
  overlay = false,
}: {
  model: ProviderModel;
  onEdit: () => void;
  onRemove: () => void;
  reorderLabel: string;
  dragProps?: HTMLAttributes<HTMLDivElement>;
  testControl?: ReactNode;
  overlay?: boolean;
}): JSX.Element {
  return (
    <div
      {...dragProps}
      aria-label={reorderLabel}
      title={i18n.t("settings:providers.dragHint") as string}
      className={cn("flex cursor-grab select-none items-center gap-2 rounded-md py-1.5 hover:bg-muted/40 active:cursor-grabbing", overlay && "rounded-lg border border-border bg-card px-3 shadow-lg")}
    >
      <button type="button" className="min-w-0 flex-1 cursor-grab truncate text-left text-sm active:cursor-grabbing" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onClick={onEdit}>
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
      {overlay ? null : (
        <div className="flex cursor-default items-center gap-2 [&_button]:cursor-pointer" title="" onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          {testControl}
          <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={i18n.t("settings:providers.removeModel") as string}>
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </Button>
        </div>
      )}
    </div>
  );
}
function SortableProviderModelRow({
  provider,
  model,
  disabled,
  onEdit,
  onRemove,
  onMove,
  reorderLabel,
}: {
  provider: ProviderConfig;
  model: ProviderModel;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  reorderLabel: string;
}): JSX.Element {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: model.id,
    disabled,
    transition: { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : undefined,
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
      }}
      className="touch-pan-y"
    >
      <ProviderModelRow
        model={model}
        onEdit={onEdit}
        onRemove={onRemove}
        reorderLabel={reorderLabel}
        dragProps={{
          ...listeners,
          onKeyDown: (event) => {
            if (!disabled && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              event.stopPropagation();
              onMove(event.key === "ArrowUp" ? -1 : 1);
            }
          },
        }}
        testControl={<ProviderTest provider={provider} model={model} disabled={disabled} onEditModel={onEdit} />}
      />
    </div>
  );
}
export function ProviderDetail({
  provider,
  onAddModels,
  onEditModel,
  onOAuth,
  onLogout,
  onChanged,
  onConfigureGateway,
  onIdentified,
}: {
  provider: ProviderConfig;
  onAddModels: () => void;
  /** Opens 模型详情 for one entry of the model list. */
  onEditModel: (model: ProviderModel) => void;
  /** Starts (or restarts) the subscription login this provider advertises. */
  onOAuth: () => void;
  onLogout: () => void;
  onChanged: (next: ProviderConfig[]) => Promise<void>;
  onConfigureGateway: () => void;
  onIdentified: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const native = provider.kind === "native";
  /** Only custom providers own their identity and endpoint; the SDK owns native ones. */
  const editable = provider.kind === "custom";
  /** A native provider's model list is offline, so it needs no key to manage. */
  const connected = provider.hasKey || provider.hasOAuth;
  const canManageModels = native || connected;
  const balance = gatewayRowState(provider);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelOrderOverride, setModelOrderOverride] = useState<string[] | null>(null);
  const [draggingModelId, setDraggingModelId] = useState<string | null>(null);

  const modelList = useMemo(
    () => orderProviderModels(provider.models, modelOrderOverride ?? provider.modelOrder),
    [provider.models, provider.modelOrder, modelOrderOverride],
  );
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  useEffect(() => {
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setShowKey(false);
    setModelOrderOverride(null);
  }, [provider.id, provider.name, provider.baseUrl, provider.modelOrder]);

  async function save(patch: {
    baseUrl?: string;
    api?: ProviderApi;
    apiKey?: string;
    models?: ProviderModel[];
    modelOrder?: string[];
  }): Promise<boolean> {
    setSaving(true);
    try {
      await onChanged(await window.fastvibe.providers.update({ id: provider.id, ...patch }));
      if (patch.apiKey !== undefined) setApiKey("");
      return true;
    } catch (err) {
      toast.error(cleanError(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removeModel(id: string): Promise<void> {
    await save({ models: modelList.filter((item) => item.id !== id) });
  }

  async function reorderModels(next: ProviderModel[]): Promise<void> {
    const modelOrder = next.map((model) => model.id);
    setModelOrderOverride(modelOrder);
    if (!(await save({ models: next, modelOrder }))) setModelOrderOverride(null);
  }

  function handleDragStart(event: DragStartEvent): void {
    setDraggingModelId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    setDraggingModelId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = modelList.map((model) => model.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    void reorderModels(arrayMove(modelList, from, to));
  }

  const activeModel = draggingModelId ? modelList.find((model) => model.id === draggingModelId) ?? null : null;

  return (
    <div className="space-y-4">
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
          <p className="truncate text-sm text-muted-foreground">
            {provider.baseUrl}
          </p>
        </Field>
      ) : null}

      {native ? (
        <Field label={t("providers.apiFormat")}>
          <p className="truncate text-sm text-muted-foreground">
            {provider.api}
          </p>
        </Field>
      ) : (
        <Field label={t("providers.apiFormat")}>
          <div className="space-y-1.5">
            {/* Only an SDK built-in is pinned, because its api comes from the registry. */}
            <Select
              items={PROVIDER_API_ITEMS}
              value={provider.api}
              disabled={saving}
              onValueChange={(value) => {
                if (value) void save({ api: value as ProviderApi });
              }}
            >
              <SelectTrigger className="w-full" title={t("providers.apiFormatHint")}>
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
          </div>
        </Field>
      )}

      {provider.oauth ? (
        <Field label={t("providers.oauthField")}>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("min-w-0 flex-1 truncate text-sm", !provider.hasOAuth && "text-muted-foreground")}>
                {provider.hasOAuth
                  ? t("providers.oauthLoggedIn", { name: provider.oauth.name })
                  : provider.oauth.name}
              </span>
              <Button size="xs" variant="outline" disabled={saving} onClick={onOAuth}>
                {provider.hasOAuth ? t("providers.oauthRelogin") : t("providers.oauthLogin")}
              </Button>
              {provider.hasOAuth ? (
                <Button size="xs" variant="ghost" disabled={saving} onClick={onLogout}>
                  {t("providers.oauthLogout")}
                </Button>
              ) : null}
            </div>
            <OAuthExtraUsageNote oauth={provider.oauth} />
          </div>
        </Field>
      ) : null}

      {provider.supportsKey ? (
        <Field label={t("providers.apiKey")}>
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  value={apiKey}
                  placeholder={provider.hasKey ? t("providers.keySaved") : t("providers.pasteKey")}
                  className="pr-8"
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setShowKey((value) => !value)}
                  aria-label={showKey ? t("providers.hideKey") : t("providers.showKey")}
                >
                  <HugeiconsIcon strokeWidth={2} icon={showKey ? ViewOffSlashIcon : ViewIcon} />
                </Button>
              </div>
              <Button
                variant="outline"
                disabled={!apiKey.trim() || saving}
                onClick={() => void save({ apiKey: apiKey.trim() })}
              >
                {t("providers.save")}
              </Button>
            </div>
            {/* A key is resolved before a stored token, so it quietly takes over. */}
            {provider.hasOAuth && provider.hasKey ? (
              <p className="text-xs text-muted-foreground">{t("providers.keyOverridesOauth")}</p>
            ) : null}
          </div>
        </Field>
      ) : null}

      {balance.readable || balance.offerIdentify ? (
        <Field label={t("providers.balance")}>
          <GatewayBalance provider={provider} onConfigure={onConfigureGateway} onIdentified={onIdentified} />
        </Field>
      ) : null}

      <OpenAIQuota provider={provider} />

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">{t("providers.models")} <span className="ml-1 font-normal text-muted-foreground">{modelList.length}</span></Label>
          <div className="flex items-center gap-1">
            <IconButton size="icon-xs" variant="ghost" label={t("providers.addModel")} disabled={!canManageModels} onClick={onAddModels}>
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
            </IconButton>
            {canManageModels ? (
              <Button size="icon-xs" variant="ghost" onClick={onAddModels} aria-label={t("providers.syncModels")}>
                <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
              </Button>
            ) : null}
          </div>
        </div>
        {modelList.length ? (
          // A provider can carry hundreds of models; the list scrolls instead of
          // stretching the whole pane.
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDraggingModelId(null)}
          >
            <SortableContext items={modelList.map((model) => model.id)} strategy={verticalListSortingStrategy}>
              <div className="max-h-96 overflow-y-auto">
                {modelList.map((model) => (
                  <SortableProviderModelRow
                    key={model.id}
                    provider={provider}
                    model={model}
                    disabled={saving}
                    onEdit={() => onEditModel(model)}
                    onRemove={() => void removeModel(model.id)}
                    onMove={(direction) => {
                      const from = modelList.findIndex((item) => item.id === model.id);
                      const to = from + direction;
                      if (to >= 0 && to < modelList.length) void reorderModels(arrayMove(modelList, from, to));
                    }}
                    reorderLabel={t("providers.reorderModel", { name: providerModelLabel(model) })}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay
              dropAnimation={{
                duration: 180,
                easing: "cubic-bezier(0.2, 0, 0, 1)",
                sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
              } as DropAnimation}
            >
              {activeModel ? (
                <ProviderModelRow
                  model={activeModel}
                  onEdit={() => undefined}
                  onRemove={() => undefined}
                  reorderLabel={t("providers.reorderModel", { name: providerModelLabel(activeModel) })}
                  overlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            {canManageModels ? t("providers.noModelsAdd") : t("providers.noModelsConnect")}
          </p>
        )}

      </div>
    </div>
  );
}
function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1000)}K`;
}
