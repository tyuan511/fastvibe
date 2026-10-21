import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, BoxesIcon, Download01Icon, Loading03Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SettingsGroup, SettingsRow } from "./settings-group";
import { providerLabel } from "@/lib/provider-label";
import { cleanError } from "@/lib/ipc-error";
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { ProviderIcon } from "@/components/provider-icon";
import type { FastVibeModel, NativeProviderConfig, ProviderConfig, ProviderModel } from "@shared/types";
import { ModelDetailDialog, type ModelDetailTarget } from "./model-detail-dialog";
import { ModelThinkingSelect } from "@/components/model-thinking-select";
import { DefaultModelSelect } from "./default-model-select";
import { OAuthLoginDialog, type OAuthTarget } from "./oauth-login-dialog";
import { GatewayCredentialDialog } from "./gateway-credential-dialog";
import { EMPTY_ADD, type AddState, type PickerState } from "./providers-settings-types";
import { fetchAddCandidates, logout, saveAdd, savePicker, startAddModels } from "./providers-settings-actions";
import { useSettingsStore } from "@/stores/settings";
import { ProjectDefaultsSection } from "./project-defaults";
import { ProviderDetail } from "./provider-detail";
import { ProviderCardActions, ProviderCardName } from "./provider-card-actions";
import { CcSwitchImportDialog } from "./cc-switch-import-dialog";
import { AddProviderDialog, ModelPickDialog } from "./add-provider-dialog";

export function ProvidersSettings({ onChanged, models = [] }: { onChanged: () => void; models?: FastVibeModel[] }): JSX.Element {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [natives, setNatives] = useState<NativeProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reordering, setReordering] = useState(false);
  const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  const openProvider = (id: string): void => {
    setQuery("");
    setSelectedId(id);
  };
  const [add, setAdd] = useState<AddState | null>(null);
  const [ccSwitchOpen, setCcSwitchOpen] = useState(false);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [detail, setDetail] = useState<ModelDetailTarget | null>(null);
  /**
   * The subscription login on screen. `next` is what to do once it succeeds: continue
   * the 添加供应商 flow with the model picker, or just refresh a provider's row. It is
   * carried here rather than inside the dialog because only the caller knows which
   * flow it is.
   */
  const [oauth, setOauth] = useState<{ target: OAuthTarget; next: () => void } | null>(null);
  /** The provider whose panel credential is being configured (new-api balance). */
  const [gatewayCredentialFor, setGatewayCredentialFor] = useState<ProviderConfig | null>(null);

  async function refresh(): Promise<ProviderConfig[]> {
    const next = await window.fastvibe.providers.list();
    setProviders(next);
    return next;
  }

  useEffect(() => {
    void Promise.all([refresh(), window.fastvibe.providers.native().then(setNatives)])
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function mutate(action: () => Promise<ProviderConfig[]>): Promise<ProviderConfig[]> {
    const next = await action();
    setProviders(next);
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
    if (!provider) throw new Error(t("providers.missing"));
    await mutate(() =>
      window.fastvibe.providers.update({
        id: provider.id,
        models: provider.models.map((item) => (item.id === next.id ? next : item)),
      }),
    );
    setDetail(null);
  }

  async function reorderProviders(activeId: string, overId: string): Promise<void> {
    if (activeId === overId || reordering) return;
    const from = providers.findIndex((provider) => providerSortId(provider.id) === activeId);
    const to = providers.findIndex((provider) => providerSortId(provider.id) === overId);
    if (from < 0 || to < 0) return;
    // Reorder the full catalog even when a search hides some of its rows.
    const next = arrayMove(providers, from, to);
    setProviders(next);
    setReordering(true);
    try {
      setProviders(await window.fastvibe.providers.reorder(next.map((provider) => provider.id)));
      onChanged();
    } catch (error) {
      toast.error(cleanError(error));
      await refresh().catch(() => setProviders(providers));
    } finally {
      setReordering(false);
    }
  }

  const draggingProvider = providers.find((provider) => providerSortId(provider.id) === draggingProviderId);
  const needle = query.trim().toLocaleLowerCase();
  const visibleProviders = providers.filter((provider) =>
    [providerLabel(provider.name || provider.id), provider.id, provider.baseUrl,
      ...provider.models.flatMap((model) => [model.id, model.name ?? ""])]
      .some((value) => value.toLocaleLowerCase().includes(needle)),
  );

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
        {t("providers.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsGroup>
        <SettingsRow
          title={t("defaultModel.title")}
          description={t(models.length ? "defaultModel.desc" : "defaultModel.emptyHint")}
          control={
            <ModelThinkingSelect
              models={models}
              model={settings.defaultModel}
              thinkingLevel={settings.thinkingLevel}
              allowAuto
              onModelChange={(model) => updateSettings({ defaultModel: model })}
              onThinkingChange={(thinkingLevel) => updateSettings({ thinkingLevel })}
              surface="settings"
              ariaLabel={t("defaultModel.title")}
              emptyModelLabel={t("defaultModel.followLast")}
              inheritModelLabel={t("defaultModel.followLast")}
            />
          }
        />
        <SettingsRow
          title={t("lightModel.title")}
          description={t(models.length ? "lightModel.desc" : "defaultModel.emptyHint")}
          control={
            <DefaultModelSelect
              models={models}
              value={settings.lightModel}
              emptyLabel={t("lightModel.followSession")}
              ariaLabel={t("lightModel.title")}
              onChange={(model) => updateSettings({ lightModel: model })}
            />
          }
        />
        <ProjectDefaultsSection models={models} />
      </SettingsGroup>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <h3 className="text-sm font-medium">{t("providers.providers")} <span className="ml-1 font-normal text-muted-foreground">{providers.length}</span></h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCcSwitchOpen(true)}>
              <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />
              {t("providers.importCcSwitch")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAdd({ ...EMPTY_ADD, selected: new Set() })}>
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
              {t("providers.add")}
            </Button>
          </div>
        </div>
        {providers.length > 0 ? (
          <div className="relative">
            <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("providers.searchProviders")} aria-label={t("providers.searchProviders")} className="pl-9" />
          </div>
        ) : null}
        {visibleProviders.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={({ active }) => setDraggingProviderId(String(active.id))}
            onDragEnd={({ active, over }) => {
              setDraggingProviderId(null);
              if (over) void reorderProviders(String(active.id), String(over.id));
            }}
            onDragCancel={() => setDraggingProviderId(null)}
          >
            <SortableContext items={visibleProviders.map((provider) => providerSortId(provider.id))} strategy={verticalListSortingStrategy}>
              <SettingsGroup>
                <Accordion
                  value={selectedId ? [selectedId] : []}
                  onValueChange={(value) => setSelectedId((value[0] as string | undefined) ?? null)}
                  className="gap-0"
                >
                  {visibleProviders.map((provider) => (
                    <SortableProviderItem
                      key={provider.id}
                      provider={provider}
                      disabled={reordering}
                      onRename={async (name) => { await mutate(() => window.fastvibe.providers.update({ id: provider.id, name })); }}
                      actions={
                        <ProviderCardActions
                          provider={provider}
                          disabled={reordering}
                          onUpdate={async (patch) => { await mutate(() => window.fastvibe.providers.update({ id: provider.id, ...patch })); }}
                          onRemove={async () => {
                            await mutate(() => window.fastvibe.providers.remove(provider.id));
                            if (selectedId === provider.id) setSelectedId(null);
                          }}
                        />
                      }
                      onMove={(direction) => {
                        const index = visibleProviders.findIndex((item) => item.id === provider.id);
                        const target = visibleProviders[index + direction];
                        if (target) void reorderProviders(providerSortId(provider.id), providerSortId(target.id));
                      }}
                    >
                      <ProviderDetail
                        provider={provider}
                        onAddModels={() => {
                          void startAddModels(provider, setPicker);
                        }}
                        onEditModel={(model) => setDetail({ providerId: provider.id, model })}
                        onOAuth={() => {
                          // The flow opens the host's system browser and waits on a loopback
                          // callback there; nothing about it can complete from a tab.
                          if (!provider.oauth) return;
                          setOauth({
                            target: { id: provider.id, name: provider.name, oauth: provider.oauth },
                            next: () => {
                              // Both views have to move: this pane's rows, and the composer's model
                              // menu — the login is what made this provider's models exist.
                              void refresh().catch(() => undefined);
                              onChanged();
                            },
                          });
                        }}
                        onLogout={() => void logout(provider, setProviders, onChanged)}
                        onConfigureGateway={() => setGatewayCredentialFor(provider)}
                        onIdentified={() => void refresh().catch(() => undefined)}
                        onChanged={async (next) => {
                          setProviders(next);
                          onChanged();
                        }}
                      />
                    </SortableProviderItem>
                  ))}
                </Accordion>
              </SettingsGroup>
            </SortableContext>
            <DragOverlay>
              {draggingProvider ? (
                <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 shadow-lg">
                  <ProviderSummary provider={draggingProvider} />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <HugeiconsIcon strokeWidth={1.5} icon={BoxesIcon} className="mb-1 size-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t(providers.length ? "providers.noMatch" : "providers.emptyTitle")}</p>
            <p className="text-xs text-muted-foreground">{t(providers.length ? "providers.searchHint" : "providers.emptyDesc")}</p>
          </div>
        )}
      </section>

      <GatewayCredentialDialog
        provider={gatewayCredentialFor}
        onClose={() => setGatewayCredentialFor(null)}
        onSaved={() => {
          void refresh().catch(() => undefined);
          onChanged();
        }}
      />

      <CcSwitchImportDialog
        open={ccSwitchOpen}
        onClose={() => setCcSwitchOpen(false)}
        onImported={async (next) => {
          setProviders(next);
          const created = next.at(-1);
          if (created) openProvider(created.id);
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
        onFetch={() => {
          // 内置 needs no fetch — those model lists ship with the SDK — so the guard is
          // asked only on the path that would actually issue the request.
          void fetchAddCandidates(add, natives, setAdd);
        }}
        onOAuth={() => {
          const provider = natives.find((item) => item.id === add?.nativeId);
          if (!provider?.oauth || !provider.id) return;
          setOauth({
            target: { id: provider.id, name: provider.name, oauth: provider.oauth },
            next: () =>
              // Authorised, so the model list is available and no key is needed.
              setAdd((current) =>
                current?.nativeId === provider.id
                  ? {
                      ...current,
                      oauthDone: true,
                      apiKey: "",
                      candidates: provider.models,
                      selected: new Set(provider.models.map((model) => model.id)),
                    }
                  : current,
              ),
          });
        }}
        onSave={() =>
          void saveAdd(add, setAdd, async (next) => {
            const saved = await mutate(async () => next);
            const created = saved.at(-1);
            if (created) openProvider(created.id);
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

      <OAuthLoginDialog
        target={oauth?.target ?? null}
        onClose={() => setOauth(null)}
        onDone={() => {
          const next = oauth?.next;
          setOauth(null);
          next?.();
        }}
      />
    </div>
  );
}
function providerSortId(id: string): string { return `provider:${id}`; }

function SortableProviderItem({ provider, disabled, actions, onRename, onMove, children }: {
  provider: ProviderConfig;
  disabled: boolean;
  actions: ReactNode;
  onRename: (name: string) => Promise<void>;
  onMove: (direction: -1 | 1) => void;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: providerSortId(provider.id),
    disabled,
    transition: { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  return (
    <AccordionItem
      value={provider.id}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : undefined }}
      className="overflow-hidden border-border bg-card"
    >
      <div className="group/provider-header relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 pr-11 hover:bg-muted/30 [&>h3]:absolute [&>h3]:inset-0">
        <AccordionTrigger
          ref={setActivatorNodeRef}
          {...listeners}
          title={t("providers.dragHint")}
          aria-label={`${providerLabel(provider.name || provider.id)} ${t("providers.modelCount", { count: provider.models.length })}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onKeyDown={(event) => {
            if (!disabled && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              event.stopPropagation();
              onMove(event.key === "ArrowUp" ? -1 : 1);
            }
          }}
          className="cursor-grab select-none rounded-none border-0 p-0 hover:no-underline active:cursor-grabbing **:data-[slot=accordion-trigger-icon]:absolute **:data-[slot=accordion-trigger-icon]:right-4 **:data-[slot=accordion-trigger-icon]:top-1/2 **:data-[slot=accordion-trigger-icon]:-translate-y-1/2"
        />
        {/* Let the full header trigger receive clicks, except on the inline controls. */}
        <div className="pointer-events-none relative flex min-w-0 flex-1 basis-40 items-center gap-3">
          <ProviderSummary provider={provider} name={<ProviderCardName provider={provider} disabled={disabled} onRename={onRename} />} />
        </div>
        <div className="relative z-10 max-w-full">{actions}</div>
      </div>
      <AccordionContent className="h-auto px-4 pb-4 pt-1 [&_p:not(:last-child)]:mb-0">
        {children}
      </AccordionContent>
    </AccordionItem>
  );
}

function ProviderSummary({ provider, name }: { provider: ProviderConfig; name?: ReactNode }): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {provider.kind === "native" ? <ProviderIcon provider={provider.id} /> : <HugeiconsIcon strokeWidth={2} icon={BoxesIcon} className="size-3.5 text-muted-foreground" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name ?? providerLabel(provider.name || provider.id)}</span>
      <span className="shrink-0 text-right text-xs font-normal text-muted-foreground">{t("providers.modelCount", { count: provider.models.length })}</span>
    </>
  );
}
