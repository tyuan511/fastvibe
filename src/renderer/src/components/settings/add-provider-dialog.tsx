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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providerLabel } from "@/lib/provider-label";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/provider-icon";
import { PROVIDER_APIS, type CcSwitchCandidate, type CcSwitchScan, type EngineModel, type FastVibeModel, type GatewayKind, type Project, type ProjectModelDefault, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { ModelPicker } from "./model-picker";
import { EMPTY_ADD, PROVIDER_API_ITEMS, PROVIDER_API_SHORT, type AddMode, type AddState, type PickerState } from "./providers-settings-types";
import { Field } from "./provider-field";

export function AddProviderDialog({
  state,
  natives,
  addedIds,
  onPatch,
  onClose,
  onFetch,
  onOAuth,
  onSave,
}: {
  state: AddState | null;
  natives: NativeProviderConfig[];
  addedIds: string[];
  onPatch: (next: Partial<AddState>) => void;
  onClose: () => void;
  onFetch: () => void;
  /** Starts the subscription login for the picked built-in provider. */
  onOAuth: () => void;
  onSave: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const native = state?.mode === "native";
  const picked = native ? natives.find((item) => item.id === state?.nativeId) : undefined;
  /** A login-only built-in (`openai-codex`) has no key field at all. */
  const showKey = !native || (picked?.supportsKey ?? true);

  function setMode(mode: AddMode): void {
    // Switching source resets the picked provider, any fetched candidates and the
    // login it may have completed — a token for one provider is not a credential for
    // the next one.
    onPatch({ mode, nativeId: null, oauthDone: false, candidates: null, selected: new Set() });
  }

  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Width is fixed per view so switching source tabs never resizes the dialog. */}
      <DialogContent className={cn(state?.candidates ? "overflow-hidden sm:max-w-2xl" : "overflow-visible sm:max-w-md")}>
        <DialogHeader>
          <DialogTitle>{state?.candidates ? t("providers.pickModels") : t("providers.add")}</DialogTitle>
          <DialogDescription>
            {state?.candidates
              ? t("providers.fetched", { count: state.candidates.length })
              : native
                ? t("providers.pickNative")
                : t("providers.fillCustom")}
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
                ["native", t("providers.kindNative")],
                ["custom", t("providers.kindCustom")],
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
                onSelect={(nativeId) => onPatch({ nativeId, oauthDone: false })}
              />
            ) : (
              <>
                <Field label={t("providers.name")}>
                  <Input autoFocus value={state.name} placeholder={t("providers.namePlaceholder")} onChange={(event) => onPatch({ name: event.target.value })} />
                </Field>
                <Field label="Base URL">
                  <Input
                    value={state.baseUrl}
                    placeholder={state.api === "google-generative-ai" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.example.com/v1"}
                    onChange={(event) => onPatch({ baseUrl: event.target.value })}
                  />
                </Field>
                <Field label={t("providers.apiFormat")}>
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
                {/*
                  What the endpoint turned out to be. It is a label, not a control: both
                  relay families answer /chat/completions, /responses and /v1/messages, so
                  there is no protocol to pick *because* of this — the format above stays
                  the user's own choice.
                */}
                {state.gateway ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="font-normal">
                      {t("providers.gatewayDetected", {
                        gateway: state.gateway === "sub2api" ? t("providers.gatewaySub2api") : t("providers.gatewayNewApi"),
                      })}
                    </Badge>
                    {t("providers.gatewayHint")}
                  </p>
                ) : null}
              </>
            )}
            {picked?.oauth ? (
              <Field label={t("providers.oauthField")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("min-w-0 flex-1 truncate text-sm", !state?.oauthDone && "text-muted-foreground")}>
                    {state?.oauthDone
                      ? t("providers.oauthLoggedIn", { name: picked.oauth.name })
                      : picked.oauth.loginLabel ?? picked.oauth.name}
                  </span>
                  <Button size="xs" variant="outline" onClick={onOAuth}>
                    {state?.oauthDone ? t("providers.oauthRelogin") : t("providers.oauthLogin")}
                  </Button>
                </div>
              </Field>
            ) : null}
            {showKey ? (
              <Field label={t("providers.apiKey")}>
                <Input
                  type="password"
                  autoComplete="off"
                  value={state.apiKey}
                  placeholder={native ? t("providers.pasteNativeKey") : "sk-......"}
                  onChange={(event) => onPatch({ apiKey: event.target.value })}
                />
              </Field>
            ) : null}
          </div>
        ) : null}
        <DialogFooter className="gap-2">
          {state?.candidates ? (
            <>
              <Button variant="outline" onClick={() => onPatch({ candidates: null })}>
                <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
                {t("providers.back")}
              </Button>
              <Button onClick={onSave} disabled={state.busy || state.selected.size === 0}>
                {state.busy ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
                {t("providers.addSelected", { count: state.selected.size })}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                {t("providers.cancel")}
              </Button>
              <Button onClick={onFetch} disabled={state?.busy}>
                {state?.busy ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
                {t("providers.confirm")}
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
  const { t } = useTranslation("settings");
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
    <Field label={t("providers.provider")}>
      <div ref={rootRef} className="relative">
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          className="h-8 w-full min-w-0 justify-between px-2.5 font-normal"
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.name : t("providers.pickBuiltin")}
          </span>
          <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
        {open ? (
          <div className="overlay-surface absolute top-[calc(100%+0.375rem)] left-0 z-50 w-full rounded-md bg-popover/95 p-1">
            <div className="relative mb-0.5 px-0.5 pt-0.5">
              <HugeiconsIcon
                strokeWidth={2}
                icon={Search01Icon}
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                value={query}
                placeholder={t("providers.searchBuiltin")}
                className="h-7 rounded-md border-0 bg-transparent pl-6.5 text-sm shadow-none focus-visible:ring-0"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="max-h-52 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("providers.noMatch")}</p>
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
                      <ProviderIcon provider={provider.id} />
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="block truncate text-sm">{provider.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {!provider.supported
                            ? provider.unsupportedReason
                            : added
                              ? t("providers.alreadyAdded")
                              : // A login-only built-in has no key to paste, so say what it
                                // needs instead of quoting a model count.
                                provider.oauth && !provider.supportsKey
                                ? t("providers.loginOnly", { name: provider.oauth.name })
                                : t("providers.modelCount", { count: provider.models.length })}
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
export function ModelPickDialog({
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
  const { t } = useTranslation("settings");
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{state?.kind === "connect" ? t("providers.pickModels") : t("providers.manageModels", { name: providerLabel(provider?.name || provider?.id) })}</DialogTitle>
          <DialogDescription>
            {state?.candidates ? t("providers.pulled", { count: state.candidates.length }) : t("providers.fetching")}
          </DialogDescription>
        </DialogHeader>
        {state?.busy && !state.candidates ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
            {t("providers.fetching")}
          </div>
        ) : state?.candidates ? (
          <ModelPicker
            models={state.candidates}
            selected={state.selected}
            onSelectedChange={(selected) => onPatch({ selected })}
          />
        ) : (
          <p className="text-xs text-destructive">{t("providers.fetchFailed")}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("providers.cancel")}
          </Button>
          <Button onClick={onSave} disabled={!state?.candidates || state.busy || state.selected.size === 0}>
            {t("providers.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
