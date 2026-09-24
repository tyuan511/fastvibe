import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { cleanError } from "@/lib/ipc-error";
import type { NativeProviderConfig, ProviderConfig, ProviderModel } from "@shared/types";
import type { AddState, PickerState } from "./providers-settings-types";

type SetPicker = (value: PickerState | null | ((current: PickerState | null) => PickerState | null)) => void;
type SetAdd = (value: AddState | null | ((current: AddState | null) => AddState | null)) => void;
type MutateProviders = (action: () => Promise<ProviderConfig[]>) => Promise<ProviderConfig[]>;

export async function startConnect(
  provider: ProviderConfig,
  apiKey: string,
  setPicker: (state: PickerState) => void,
): Promise<void> {
  setPicker({
    kind: "connect",
    providerId: provider.id,
    apiKey,
    candidates: null,
    selected: new Set(),
    busy: true,
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
    });
  } catch (err) {
    toast.error(cleanError(err));
    setPicker({
      kind: "connect",
      providerId: provider.id,
      apiKey,
      candidates: null,
      selected: new Set(),
      busy: false,
    });
  }
}

export async function startAddModels(
  provider: ProviderConfig,
  setPicker: (state: PickerState) => void,
): Promise<void> {
  setPicker({
    kind: "models",
    providerId: provider.id,
    candidates: null,
    selected: new Set(provider.models.map((item) => item.id)),
    busy: true,
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
    });
  } catch (err) {
    toast.error(cleanError(err));
    setPicker({
      kind: "models",
      providerId: provider.id,
      candidates: null,
      selected: new Set(),
      busy: false,
    });
  }
}

export async function fetchAddCandidates(
  add: AddState | null,
  natives: NativeProviderConfig[],
  setAdd: SetAdd,
): Promise<void> {
  if (!add) return;

  // Built-in providers already have their full model list bundled with the SDK,
  // so there is nothing to fetch — go straight to the picker.
  if (add.mode === "native") {
    const provider = natives.find((item) => item.id === add.nativeId);
    if (!provider) {
      toast.error(i18n.t("settings:providers.needBuiltin") as string);
      return;
    }
    if (!provider.supported) {
      toast.error(provider.unsupportedReason ?? (i18n.t("settings:providers.unsupportedKey") as string));
      return;
    }
    // Either credential is enough: a pasted key, or a login that just completed.
    if (!add.apiKey.trim() && !add.oauthDone) {
      toast.error(i18n.t(provider.oauth ? "settings:providers.needKeyOrLogin" : "settings:providers.needKey") as string);
      return;
    }
    setAdd({
      ...add,
      candidates: provider.models,
      selected: new Set(provider.models.map((item) => item.id)),
      busy: false,
    });
    return;
  }

  if (!add.name.trim() || !add.baseUrl.trim() || !add.apiKey.trim()) {
    toast.error(i18n.t("settings:providers.needFields") as string);
    return;
  }
  setAdd({ ...add, busy: true });
  try {
    // Both calls are independent requests to the same host, so they go together rather
    // than one after the other — the probe is what lets the dialog say which product
    // this is, and a relay's panel answers as fast as its model list.
    const [models, gateway] = await Promise.all([
      window.fastvibe.providers.fetch(add.baseUrl, add.apiKey, add.api),
      window.fastvibe.providers.probeGateway(add.baseUrl).catch(() => undefined),
    ]);
    setAdd({
      ...add,
      gateway,
      candidates: models,
      selected: new Set(models.map((item) => item.id)),
      busy: false,
    });
  } catch (err) {
    toast.error(cleanError(err));
    setAdd({ ...add, busy: false });
  }
}

export async function saveAdd(
  add: AddState | null,
  setAdd: (value: AddState | null) => void,
  onSaved: (next: ProviderConfig[]) => Promise<void>,
): Promise<void> {
  if (!add?.candidates) return;
  const models = add.candidates.filter((item) => add.selected.has(item.id));
  if (models.length === 0) {
    toast.error(i18n.t("settings:providers.needModel") as string);
    return;
  }
  if (add.mode === "native" && !add.nativeId) {
    toast.error(i18n.t("settings:providers.needBuiltin") as string);
    return;
  }
  setAdd({ ...add, busy: true });
  try {
    const next =
      add.mode === "native"
        ? await window.fastvibe.providers.addNative({ id: add.nativeId!, apiKey: add.apiKey.trim(), models })
        : await window.fastvibe.providers.add({
          name: add.name.trim(),
          baseUrl: add.baseUrl.trim(),
          apiKey: add.apiKey.trim(),
          api: add.api,
          ...(add.gateway ? { gateway: add.gateway } : {}),
          models,
        });
    setAdd(null);
    await onSaved(next);
  } catch (err) {
    toast.error(cleanError(err));
    setAdd({ ...add, busy: false });
  }
}

/** Drop a subscription credential, leaving the provider entry in place (and re-loginable). */
export async function logout(
  provider: ProviderConfig,
  setProviders: (next: ProviderConfig[]) => void,
  onChanged: () => void,
): Promise<void> {
  try {
    setProviders(await window.fastvibe.providers.logout(provider.id));
    onChanged();
  } catch (err) {
    toast.error(cleanError(err));
  }
}

export async function savePicker(
  picker: PickerState | null,
  providers: ProviderConfig[],
  setPicker: SetPicker,
  mutate: MutateProviders,
): Promise<void> {
  if (!picker?.candidates) return;
  const models = picker.candidates.filter((item) => picker.selected.has(item.id));
  const provider = providers.find((item) => item.id === picker.providerId);
  const existing = new Map((provider?.models ?? []).map((item) => [item.id, item]));
  const missing = (provider?.models ?? []).filter((item) => !picker.candidates!.some((candidate) => candidate.id === item.id));
  const nextModels = [...models, ...missing].map((model) => {
    const stored = existing.get(model.id);
    // A re-fetched model list has no memory of the per-model protocol pin, so carry
    // the stored override over instead of silently resetting the model to the provider's api.
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
      // The stored value is authoritative even when it is absent: absence means the
      // user chose to inherit, so a newly inferred protocol must not overwrite it.
      api: stored.api,
      // Prices are not editable but they are metadata: a model id the catalog does not
      // know keeps the price it was stored with instead of losing it on the next sync.
      cost: stored.cost ?? model.cost,
      costTiers: stored.costTiers ?? model.costTiers,
      edited: true,
    };
  });
  setPicker((current) => (current ? { ...current, busy: true } : current));
  try {
    if (picker.kind === "connect" && picker.apiKey) {
      await mutate(() => window.fastvibe.providers.saveFastVibe(picker.apiKey!, nextModels));
    } else {
      await mutate(() => window.fastvibe.providers.update({ id: picker.providerId, models: nextModels }));
    }
    setPicker(null);
  } catch (err) {
    toast.error(cleanError(err));
    setPicker((current) => (current ? { ...current, busy: false } : current));
  }
}
