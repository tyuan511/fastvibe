import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  BoxesIcon,
  Delete02Icon,
  Download01Icon,
  Loading03Icon,
  PencilEdit02Icon,
  CircleQuestionMarkIcon,
  DragDropVerticalIcon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { ProviderIcon } from "@/components/provider-icon";
import { PROVIDER_APIS, type CcSwitchCandidate, type CcSwitchScan, type EngineModel, type FastVibeModel, type GatewayKind, type Project, type ProjectModelDefault, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { OAuthExtraUsageNote } from "./oauth-extra-usage-note";
import { GatewayBalance } from "./gateway-balance";
import { EMPTY_ADD, PROVIDER_API_ITEMS, PROVIDER_API_SHORT, type AddMode, type AddState, type PickerState } from "./providers-settings-types";
import { OpenAIQuota } from "./openai-quota";
import {
  orderProviderModels,
  providerModelLabel,
} from "@shared/model-order";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Field } from "./provider-field";

function FastVibeInfoTooltip(): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={t("providers.fastvibeAbout")}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <HugeiconsIcon strokeWidth={2} icon={CircleQuestionMarkIcon} className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>
          {t("providers.fastvibeDescription")} {" "}<a
            href="https://fastvibe.dev"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline underline-offset-3 hover:text-primary/80"
          >
            {t("providers.fastvibeVisit")}
          </a>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
function ProviderModelRow({
  model,
  onEdit,
  onRemove,
  reorderLabel,
  handleProps,
  overlay = false,
}: {
  model: ProviderModel;
  onEdit: () => void;
  onRemove: () => void;
  reorderLabel: string;
  handleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  overlay?: boolean;
}): JSX.Element {
  return (
    <div className={cn("flex items-center gap-2 px-2 py-2", overlay && "rounded-lg border border-border bg-card px-3 shadow-lg")}>
      <button
        type="button"
        {...handleProps}
        className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground active:cursor-grabbing"
        aria-label={reorderLabel}
        title={reorderLabel}
      >
        <HugeiconsIcon strokeWidth={2} icon={DragDropVerticalIcon} className="size-3.5" />
      </button>
      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm" onClick={onEdit}>
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
        <>
          <Button size="icon-xs" variant="ghost" onClick={onEdit} aria-label={i18n.t("settings:providers.modelDetail") as string}>
            <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={i18n.t("settings:providers.removeModel") as string}>
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </Button>
        </>
      )}
    </div>
  );
}
function SortableProviderModelRow({
  model,
  disabled,
  onEdit,
  onRemove,
  reorderLabel,
}: {
  model: ProviderModel;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
  reorderLabel: string;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
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
        handleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
export function ProviderDetail({
  provider,
  onConnectFastVibe,
  onAddModels,
  onEditModel,
  onOAuth,
  onLogout,
  onChanged,
  onRemoved,
  onConfigureGateway,
  onIdentified,
}: {
  provider: ProviderConfig;
  onConnectFastVibe: (apiKey: string) => void;
  onAddModels: () => void;
  /** Opens 模型详情 for one entry of the model list. */
  onEditModel: (model: ProviderModel) => void;
  /** Starts (or restarts) the subscription login this provider advertises. */
  onOAuth: () => void;
  onLogout: () => void;
  onChanged: (next: ProviderConfig[]) => Promise<void>;
  onRemoved: (next: ProviderConfig[]) => Promise<void>;
  /** Opens the panel-credential dialog for a new-api provider's balance. */
  onConfigureGateway: () => void;
  /** The gateway probe just identified this provider, so the pane re-reads the list. */
  onIdentified: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const builtin = provider.kind === "builtin";
  const native = provider.kind === "native";
  /** Only custom providers own their identity and endpoint; the SDK owns native ones. */
  const editable = provider.kind === "custom";
  /** A native provider's model list is offline, so it needs no key to manage. */
  const connected = provider.hasKey || provider.hasOAuth;
  const canManageModels = native || connected;
  const [name, setName] = useState(provider.name);
  const [editingName, setEditingName] = useState(false);
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
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    setName(provider.name);
    setEditingName(false);
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setShowKey(false);
    setModelOrderOverride(null);
  }, [provider.id, provider.name, provider.baseUrl, provider.modelOrder]);

  async function save(patch: {
    name?: string;
    baseUrl?: string;
    api?: ProviderApi;
    enabled?: boolean;
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

  async function remove(): Promise<void> {
    try {
      await onRemoved(await window.fastvibe.providers.remove(provider.id));
    } catch (err) {
      toast.error(cleanError(err));
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
    <div className="space-y-5">
      {/* Wraps rather than truncating the name: on a phone the actions on the right
          left the provider's own name as a single letter and an ellipsis. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          {provider.kind === "native" ? <ProviderIcon provider={provider.id} /> : null}
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
          {builtin ? <FastVibeInfoTooltip /> : null}
          {editable && !editingName ? (
            <Button size="icon-xs" variant="ghost" onClick={() => setEditingName(true)} aria-label={t("providers.rename")}>
              <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
            </Button>
          ) : null}
          {provider.enabled ? (
            <Badge variant="secondary" className="text-success">
              {t("providers.enabled")}
            </Badge>
          ) : (
            <Badge variant="outline">{t("providers.disabled")}</Badge>
          )}
          <Button size="xs" variant="outline" disabled={saving} onClick={() => void save({ enabled: !provider.enabled })}>
            {provider.enabled ? t("providers.disable") : t("providers.enable")}
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <GatewayBalance provider={provider} onConfigure={onConfigureGateway} onIdentified={onIdentified} />
          {!builtin ? (
            <Button size="icon-xs" variant="ghost" onClick={() => void remove()} aria-label={t("providers.delete")}>
              <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
            </Button>
          ) : null}
        </div>
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
        <Field label={t("providers.apiFormat")}>
          <p className="flex h-8 items-center rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground">
            {provider.api}
          </p>
        </Field>
      ) : (
        <Field label={t("providers.apiFormat")}>
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
              {t("providers.apiFormatHint")}
            </p>
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
              {builtin && !provider.hasKey ? (
                <Button disabled={!apiKey.trim() || saving} onClick={() => onConnectFastVibe(apiKey.trim())}>
                  {t("providers.connect")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={!apiKey.trim() || saving}
                  onClick={() => void save({ apiKey: apiKey.trim() })}
                >
                  {t("providers.save")}
                </Button>
              )}
            </div>
            {/* A key is resolved before a stored token, so it quietly takes over. */}
            {provider.hasOAuth && provider.hasKey ? (
              <p className="text-xs text-muted-foreground">{t("providers.keyOverridesOauth")}</p>
            ) : null}
          </div>
        </Field>
      ) : null}

      <OpenAIQuota provider={provider} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-normal text-muted-foreground">{t("providers.models")}</Label>
          <div className="flex items-center gap-1">
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
              <div className="max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {modelList.map((model) => (
                  <SortableProviderModelRow
                    key={model.id}
                    model={model}
                    disabled={saving}
                    onEdit={() => onEditModel(model)}
                    onRemove={() => void removeModel(model.id)}
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
        <Button
          size="xs"
          variant="outline"
          disabled={builtin && !provider.hasKey ? !apiKey.trim() : !canManageModels}
          onClick={builtin && !provider.hasKey ? () => onConnectFastVibe(apiKey.trim()) : onAddModels}
        >
          <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
          {t("providers.addModel")}
        </Button>
      </div>
    </div>
  );
}
function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1000)}K`;
}
