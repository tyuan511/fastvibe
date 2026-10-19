import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  BoxesIcon,
  Delete02Icon,
  PencilEdit02Icon,
  DragDropVerticalIcon,
  RefreshIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { PROVIDER_APIS, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { OAuthExtraUsageNote } from "./oauth-extra-usage-note";
import { GatewayBalance } from "./gateway-balance";
import { PROVIDER_API_ITEMS, PROVIDER_API_SHORT } from "./providers-settings-types";
import { OpenAIQuota } from "./openai-quota";
import {
  ModelCheckButton,
  useModelChecks,
  type ModelCheckState,
} from "./provider-test";
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
import { SettingsGroup, SettingsRow } from "./settings-group";

function ProviderModelRow({
  model,
  onEdit,
  onRemove,
  reorderLabel,
  handleProps,
  overlay = false,
  check,
  checkDisabled = false,
  onCheck,
}: {
  model: ProviderModel;
  onEdit: () => void;
  onRemove: () => void;
  reorderLabel: string;
  handleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  overlay?: boolean;
  check?: ModelCheckState;
  checkDisabled?: boolean;
  onCheck?: () => void;
}): JSX.Element {
  const showId = Boolean(model.name) && model.name !== model.id;
  return (
    <div className={cn("group/model flex items-center gap-2 px-3 py-2", overlay && "rounded-lg border border-border bg-card shadow-lg")}>
      <button
        type="button"
        {...handleProps}
        className="-ml-1 flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity group-focus-within/model:opacity-100 group-hover/model:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
        aria-label={reorderLabel}
        title={reorderLabel}
      >
        <HugeiconsIcon strokeWidth={2} icon={DragDropVerticalIcon} className="size-3.5" />
      </button>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onEdit}>
        <span className="block truncate text-sm">{model.name || model.id}</span>
        {showId ? <span className="block truncate text-xs text-muted-foreground">{model.id}</span> : null}
      </button>
      {/*
       * The row's right end is one slot with two faces: what the model *is* (its pinned
       * protocol, its context size) while the pointer is elsewhere, and what can be done to
       * it once the pointer arrives. There is no hover on touch, so touch keeps the actions
       * — the same rule every other hover-revealed control in the app follows.
       */}
      <div className="flex shrink-0 items-center gap-1.5 group-focus-within/model:hidden group-hover/model:hidden">
        {/* Only a pinned protocol is worth a chip; the inherited one is the norm. */}
        {model.api ? (
          <Badge variant="secondary" className="shrink-0 font-normal">
            {PROVIDER_API_SHORT[model.api]}
          </Badge>
        ) : null}
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
          {contextLabel(model.contextWindow)}
        </span>
      </div>
      {overlay ? null : (
        <div className="hidden shrink-0 items-center group-focus-within/model:flex group-hover/model:flex pointer-coarse:flex">
          <Button size="icon-xs" variant="ghost" onClick={onEdit} aria-label={i18n.t("settings:providers.modelDetail") as string}>
            <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={i18n.t("settings:providers.removeModel") as string}>
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </Button>
          {/* Rightmost, because it is the one control that asks the provider a question. */}
          {onCheck ? <ModelCheckButton state={check} disabled={checkDisabled} onRun={onCheck} /> : null}
        </div>
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
  check,
  checkDisabled,
  onCheck,
}: {
  model: ProviderModel;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
  reorderLabel: string;
  check?: ModelCheckState;
  checkDisabled: boolean;
  onCheck: () => void;
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
        check={check}
        checkDisabled={checkDisabled}
        onCheck={onCheck}
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
  onRemoved,
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
  onRemoved: (next: ProviderConfig[]) => Promise<void>;
  /** Opens the panel-credential dialog for a new-api provider's balance. */
  onConfigureGateway: () => void;
  /** The gateway probe just identified this provider, so the pane re-reads the list. */
  onIdentified: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
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
  const { checks, run: runCheck } = useModelChecks(provider, onEditModel);

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

  const connectedLabel = connected
    ? t("providers.modelCount", { count: provider.models.length })
    : t("providers.notConnected");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Wraps rather than truncating the name: on a phone the actions on the right
          left the provider's own name as a single letter and an ellipsis. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
            {provider.kind === "native" ? (
              <ProviderIcon provider={provider.id} className="size-5" />
            ) : (
              <HugeiconsIcon strokeWidth={2} icon={BoxesIcon} className="size-5 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1">
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
                <Button size="icon-xs" variant="ghost" onClick={() => setEditingName(true)} aria-label={t("providers.rename")}>
                  <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
                </Button>
              ) : null}
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-1.5 shrink-0 rounded-full", connected ? "bg-success" : "bg-muted-foreground/35")} />
              {connectedLabel}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <GatewayBalance provider={provider} onConfigure={onConfigureGateway} onIdentified={onIdentified} />
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="flex items-center">
                  <Switch
                    checked={provider.enabled}
                    disabled={saving}
                    onCheckedChange={(next) => void save({ enabled: next })}
                    aria-label={provider.enabled ? t("providers.disable") : t("providers.enable")}
                  />
                </span>
              }
            />
            <TooltipContent>{provider.enabled ? t("providers.enabled") : t("providers.disabled")}</TooltipContent>
          </Tooltip>
          <Button size="icon-xs" variant="ghost" onClick={() => void remove()} aria-label={t("providers.delete")}>
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </Button>
        </div>
      </div>

      <SettingsGroup>
        {editable ? (
          <SettingsRow
            title="Base URL"
            control={
              <Input
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                className="w-64 max-w-full"
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={() => {
                  const next = baseUrl.trim().replace(/\/+$/, "");
                  if (next && next !== provider.baseUrl) void save({ baseUrl: next });
                  else setBaseUrl(provider.baseUrl);
                }}
              />
            }
          />
        ) : (
          <SettingsRow
            title="Base URL"
            control={
              <span className="block max-w-64 truncate text-sm text-muted-foreground" title={provider.baseUrl}>
                {provider.baseUrl}
              </span>
            }
          />
        )}

        {native ? (
          <SettingsRow
            title={t("providers.apiFormat")}
            control={<span className="text-sm text-muted-foreground">{provider.api}</span>}
          />
        ) : (
          // Only an SDK built-in is pinned, because its api comes from the registry.
          <SettingsRow
            title={t("providers.apiFormat")}
            control={
              <Select
                items={PROVIDER_API_ITEMS}
                value={provider.api}
                disabled={saving}
                onValueChange={(value) => {
                  if (value) void save({ api: value as ProviderApi });
                }}
              >
                <SelectTrigger className="w-64 max-w-full">
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
            }
          />
        )}

        {provider.oauth ? (
          <>
            <SettingsRow
              title={t("providers.oauthField")}
              description={
                provider.hasOAuth ? t("providers.oauthLoggedIn", { name: provider.oauth.name }) : provider.oauth.name
              }
              control={
                <div className="flex items-center gap-2">
                  <Button size="xs" variant="outline" disabled={saving} onClick={onOAuth}>
                    {provider.hasOAuth ? t("providers.oauthRelogin") : t("providers.oauthLogin")}
                  </Button>
                  {provider.hasOAuth ? (
                    <Button size="xs" variant="ghost" disabled={saving} onClick={onLogout}>
                      {t("providers.oauthLogout")}
                    </Button>
                  ) : null}
                </div>
              }
            />
            {provider.oauth.extraUsage ? (
              <div className="px-4 py-2.5">
                <OAuthExtraUsageNote oauth={provider.oauth} />
              </div>
            ) : null}
          </>
        ) : null}

        {provider.supportsKey ? (
          <>
            <SettingsRow
              title={t("providers.apiKey")}
              control={
                <div className="flex w-64 max-w-full gap-2">
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
              }
            />
            {/* A key is resolved before a stored token, so it quietly takes over. */}
            {provider.hasOAuth && provider.hasKey ? (
              <p className="px-4 py-2.5 text-xs text-muted-foreground">{t("providers.keyOverridesOauth")}</p>
            ) : null}
          </>
        ) : null}
      </SettingsGroup>

      <OpenAIQuota provider={provider} />

      <section
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card",
          // Only a list with rows in it takes the leftover height; an empty state keeps its
          // own size rather than stretching a mostly blank card down the pane.
          modelList.length > 0 && "flex min-h-0 flex-1 flex-col",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <h4 className="text-sm font-medium">{t("providers.models")}</h4>
            {modelList.length ? (
              <span className="text-xs text-muted-foreground tabular-nums">{modelList.length}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {canManageModels ? (
              <Button size="icon-xs" variant="ghost" onClick={onAddModels} aria-label={t("providers.syncModels")}>
                <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
              </Button>
            ) : null}
            <Button size="xs" variant="outline" disabled={!canManageModels} onClick={onAddModels}>
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
              {t("providers.addModel")}
            </Button>
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
              {/*
               * The list is the one part of this pane that a provider makes arbitrarily
               * long, so it is the part that scrolls: it takes whatever height is left over
               * once the rows above are drawn (the pane above it, this provider's endpoint
               * rows, and the list's own header), and the window's bottom padding stays put.
               * The 6rem floor is for a window too short to give it anything: there the list
               * keeps a readable size and the pane scrolls, exactly as it did before.
               */}
              <div className="min-h-24 flex-1 divide-y divide-border overflow-y-auto border-t border-border">
                {modelList.map((model) => (
                  <SortableProviderModelRow
                    key={model.id}
                    model={model}
                    disabled={saving}
                    onEdit={() => onEditModel(model)}
                    onRemove={() => void removeModel(model.id)}
                    reorderLabel={t("providers.reorderModel", { name: providerModelLabel(model) })}
                    check={checks[model.id]}
                    checkDisabled={saving || !connected}
                    onCheck={() => runCheck(model)}
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
          <p className="border-t border-border py-8 text-center text-xs text-muted-foreground">
            {canManageModels ? t("providers.noModelsAdd") : t("providers.noModelsConnect")}
          </p>
        )}
      </section>
    </div>
  );
}
function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1000)}K`;
}
