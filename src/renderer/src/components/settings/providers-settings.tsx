import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type JSX } from "react";
import { useTranslation } from "react-i18next";
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
import { AppLogo } from "@/components/app-logo";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { providerLabel } from "@/lib/provider-label";
import { cn } from "@/lib/utils";
import { useIsNarrowViewport } from "@/lib/sidebar-visibility";
import { ProviderIcon } from "@/components/provider-icon";
import { PROVIDER_APIS, type CcSwitchCandidate, type CcSwitchScan, type EngineModel, type FastVibeModel, type GatewayKind, type Project, type ProjectModelDefault, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { ModelDetailDialog, type ModelDetailTarget } from "./model-detail-dialog";
import { ModelThinkingSelect } from "@/components/model-thinking-select";
import { OAuthLoginDialog, type OAuthTarget } from "./oauth-login-dialog";
import { GatewayCredentialDialog } from "./gateway-credential-dialog";
import { EMPTY_ADD, PROVIDER_API_ITEMS, PROVIDER_API_SHORT, type AddMode, type AddState, type PickerState } from "./providers-settings-types";
import { fetchAddCandidates, logout, saveAdd, savePicker, startAddModels, startConnect } from "./providers-settings-actions";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";
import { useSettingsStore } from "@/stores/settings";
import { ProjectDefaultsSection } from "./project-defaults";
import { ProviderDetail } from "./provider-detail";
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
  // Phone: the provider list and a provider's detail are two pages, not two columns —
  // side by side at 375pt the detail was a strip one word wide. Picking a provider opens
  // its page; the page's 返回 comes back. Desktop ignores this and shows both.
  const narrow = useIsNarrowViewport();
  const [detailOpen, setDetailOpen] = useState(false);
  const openProvider = (id: string): void => {
    setSelectedId(id);
    setDetailOpen(true);
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
      .then(([next]) => {
        setSelectedId((current) => current ?? next.find((item) => item.kind === "builtin")?.id ?? next[0]?.id ?? null);
      })
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

  const builtin = providers.find((item) => item.kind === "builtin");
  const nativeProviders = providers.filter((item) => item.kind === "native");
  const customs = providers.filter((item) => item.kind === "custom");
  const selected = providers.find((item) => item.id === selectedId) ?? builtin ?? null;

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
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{t("defaultModel.title")}</h3>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{t("defaultModel.desc")}</p>
          </div>
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
        </div>
        {models.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            {t("defaultModel.emptyHint")}
          </p>
        ) : null}
        <div className="border-t border-border px-4 py-3">
          <ProjectDefaultsSection models={models} />
        </div>
      </section>

      <div className="flex min-h-80 overflow-hidden rounded-xl border border-border bg-card">
        <aside
          className={cn(
            "flex w-52 shrink-0 flex-col border-r border-border",
            narrow && (detailOpen ? "hidden" : "w-full border-r-0"),
          )}
        >
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">
            {builtin ? (
              <div className="mb-3">
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("providers.builtin")}</p>
                <ProviderNavItem
                  provider={builtin}
                  selected={!narrow && selected?.id === builtin.id}
                  onSelect={() => openProvider(builtin.id)}
                />
              </div>
            ) : null}
            {nativeProviders.length ? (
              <div className="mb-3">
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("providers.providers")}</p>
                <div className="space-y-0.5">
                  {nativeProviders.map((provider) => (
                    <ProviderNavItem
                      key={provider.id}
                      provider={provider}
                      selected={!narrow && selected?.id === provider.id}
                      onSelect={() => openProvider(provider.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {customs.length ? (
              <div>
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("providers.custom")}</p>
                <div className="space-y-0.5">
                  {customs.map((provider) => (
                    <ProviderNavItem
                      key={provider.id}
                      provider={provider}
                      selected={!narrow && selected?.id === provider.id}
                      onSelect={() => openProvider(provider.id)}
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
            {t("providers.add")}
          </button>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted/60"
            onClick={() => setCcSwitchOpen(true)}
          >
            <HugeiconsIcon strokeWidth={2} icon={Download01Icon} className="size-3.5" />
            {t("providers.importCcSwitch")}
          </button>
        </div>
        </aside>

        <div className={cn("min-w-0 flex-1 p-5", narrow && (detailOpen ? "p-4" : "hidden"))}>
        {narrow ? (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 mb-3 h-8 gap-1.5 px-2 text-sm text-muted-foreground"
            onClick={() => setDetailOpen(false)}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} className="size-4" />
            {t("providers.providers")}
          </Button>
        ) : null}
        {selected ? (
          <ProviderDetail
            provider={selected}
            onConnectFastVibe={(apiKey) => {
              // Discovering a model list is a request to the provider's URL issued from
              // the host's network, which the policy refuses.
              if (blockedRemotely(Ipc.providersFetch)) return;
              void startConnect(selected, apiKey, setPicker);
            }}
            onAddModels={() => {
              if (blockedRemotely(Ipc.providersFetch)) return;
              void startAddModels(selected, setPicker);
            }}
            onEditModel={(model) => setDetail({ providerId: selected.id, model })}
            onOAuth={() => {
              // The flow opens the host's system browser and waits on a loopback
              // callback there; nothing about it can complete from a tab.
              if (blockedRemotely(Ipc.providersOAuthLogin)) return;
              if (!selected.oauth) return;
              setOauth({
                target: { id: selected.id, name: selected.name, oauth: selected.oauth },
                next: () => {
                  // Both views have to move: this pane's rows, and the composer's model
                  // menu — the login is what made this provider's models exist.
                  void refresh().catch(() => undefined);
                  onChanged();
                },
              });
            }}
            onLogout={() => void logout(selected, setProviders, onChanged)}
            onConfigureGateway={() => setGatewayCredentialFor(selected)}
            onIdentified={() => void refresh().catch(() => undefined)}
            onChanged={async (next) => {
              setProviders(next);
              onChanged();
            }}
            onRemoved={async (next) => {
              setProviders(next);
              setSelectedId(builtin?.id ?? next[0]?.id ?? null);
              setDetailOpen(false);
              onChanged();
            }}
          />
        ) : (
          <p className="py-10 text-center text-xs text-muted-foreground">{t("providers.pickOne")}</p>
        )}
        </div>

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
          const created = next.filter((item) => item.kind !== "builtin").at(-1);
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
          if (add?.mode !== "native" && blockedRemotely(Ipc.providersFetch)) return;
          void fetchAddCandidates(add, natives, setAdd);
        }}
        onOAuth={() => {
          if (blockedRemotely(Ipc.providersOAuthLogin)) return;
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
            const created = saved.filter((item) => item.kind !== "builtin").at(-1);
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
        // The built-in's own brand mark, else a neutral glyph — the SDK catalog is what
        // decides which, see `provider-icon.tsx`.
        <ProviderIcon provider={provider.id} />
      ) : (
        <HugeiconsIcon strokeWidth={2} icon={BoxesIcon} className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-left">{providerLabel(provider.name || provider.id)}</span>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          provider.hasKey || provider.hasOAuth ? "bg-success" : "bg-muted-foreground/35",
        )}
      />
    </button>
  );
}
