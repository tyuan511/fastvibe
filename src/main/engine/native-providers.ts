import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { THINKING_LEVELS, type NativeProviderOAuth, type ProviderModel, type ThinkingLevel } from "@shared/types";

/**
 * pi-coding-agent's own built-in provider catalog.
 *
 * The SDK already ships every provider it can talk to — 30+ providers and ~1000
 * models — with baseUrl, api, context window, modalities and thinking levels on
 * each `Model`. There is deliberately **no** hand-maintained list here: we build a
 * throwaway in-memory `ModelRegistry` (no `models.json`, so it yields built-ins
 * only) and read straight off it. Nothing touches the network and nothing needs a
 * key, so the settings UI can offer these before the user has configured anything.
 *
 * Native providers never write credentials or complete model lists to `models.json`.
 * Their credential lives outside it — an API key in the engine's in-memory credential
 * overlay, a subscription token in `agent/oauth.json` — while a small
 * `modelOverrides` block may carry user-edited metadata onto the SDK catalog. Writing
 * a native provider as a complete custom definition would be harmful because
 * `models.json` resolves `apiKey` as an environment-variable name.
 *
 * What each built-in can be configured *with* is read off the SDK rather than listed:
 * `auth.apiKey.login` says a pasted key is a real path, `auth.oauth` says the SDK ships
 * a subscription login. See `UNSUPPORTED` below for the two exceptions.
 */

/**
 * Built-ins that neither a key nor a login can configure, so the UI must not offer one.
 *
 * These are the only two names hardcoded here. Every other provider's capability is
 * read off the SDK: `auth.apiKey.login` says whether a pasted key is a real path, and
 * `auth.oauth` whether the SDK ships a subscription login. That is why
 * `openai-codex` (login only) and `github-copilot` (both) need no entry of their own,
 * and why an SDK release that adds a login shows up here without a change.
 */
const UNSUPPORTED: Record<string, string> = {
  "amazon-bedrock": "使用 AWS 凭据（AWS_PROFILE / IAM），暂不支持",
  "google-vertex": "使用 Google 应用默认凭据（gcloud auth），暂不支持",
};

/**
 * Subscription logins whose usage a third-party harness pays for from a separate
 * «extra usage» balance instead of the plan's included limits, mapped to where the
 * account enables and checks it.
 *
 * Anthropic's Claude Pro/Max is the one that behaves this way — pi's own CLI warns
 * about it for any `sk-ant-oat…` credential, and a request is refused (`third-party
 * apps not draw from your extra usage`) until that balance is enabled. It is a
 * billing fact about one provider, not a capability the SDK exposes, so it is the
 * second (and last) thing named here by hand. Every other subscription login
 * (Copilot, ChatGPT, Kimi, Grok) bills through its own subscription as usual and
 * needs no note.
 */
const EXTRA_USAGE_LOGINS: Record<string, string> = {
  anthropic: "https://claude.ai/settings/usage",
};

export type NativeProvider = {
  /** SDK provider id, e.g. `deepseek`. FastVibe uses it verbatim as the stored id. */
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  models: ProviderModel[];
  /** Configurable by pasting an API key, i.e. the SDK provider has a key login. */
  supportsKey: boolean;
  /** The subscription login the SDK ships for it, if any. */
  oauth?: NativeProviderOAuth;
  /** False when it needs cloud credentials rather than a key or a login. */
  supported: boolean;
  unsupportedReason?: string;
};

let cached: NativeProvider[] | null = null;

/** Every built-in provider the SDK knows about, alphabetical by display name. */
export function listNativeProviders(): NativeProvider[] {
  if (cached) return cached;

  const grouped = new Map<
    string,
    { name: string; api: string; baseUrl: string; models: ProviderModel[]; supportsKey: boolean; oauth?: NativeProviderOAuth }
  >();

  for (const provider of builtinProviders()) {
    const extraUsageUrl = EXTRA_USAGE_LOGINS[provider.id];
    const entry = grouped.get(provider.id) ?? {
      name: provider.name,
      api: "",
      baseUrl: "",
      models: [],
      // No key login means the only way in is a login or an ambient credential;
      // `envApiKeyAuth` (and Anthropic's hand-written equivalent) always provides one.
      supportsKey: typeof provider.auth.apiKey?.login === "function",
      oauth: provider.auth.oauth
        ? {
            name: provider.auth.oauth.name,
            isSubscription: provider.auth.oauth.isSubscription === true,
            ...(provider.auth.oauth.loginLabel ? { loginLabel: provider.auth.oauth.loginLabel } : {}),
            ...(extraUsageUrl ? { extraUsage: { url: extraUsageUrl } } : {}),
          }
        : undefined,
    };
    for (const model of provider.getModels()) {
      // Every model of a provider shares its api/baseUrl; the first one seen defines it.
      if (!entry.api) entry.api = model.api;
      if (!entry.baseUrl) entry.baseUrl = model.baseUrl;
      entry.models.push(toProviderModel(model));
    }
    grouped.set(provider.id, entry);
  }

  cached = [...grouped.entries()]
    .map(([id, entry]) => {
      const reason = UNSUPPORTED[id];
      // A `radius` gateway advertises a login but has no catalog until it is
      // configured, and FastVibe keeps model networking off — offering it would only
      // produce a provider with nothing to talk to.
      const oauth = entry.models.length > 0 ? entry.oauth : undefined;
      return {
        id,
        name: entry.name,
        api: entry.api,
        baseUrl: entry.baseUrl,
        models: entry.models.sort((a, b) => a.name.localeCompare(b.name)),
        supportsKey: entry.supportsKey,
        oauth,
        supported: !reason && (entry.supportsKey || Boolean(oauth)),
        ...(reason
          ? { unsupportedReason: reason }
          : entry.supportsKey || oauth
            ? {}
            : { unsupportedReason: "需要该供应商的登录方式，暂不支持" }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return cached;
}

export function findNativeProvider(id: string): NativeProvider | undefined {
  return listNativeProviders().find((provider) => provider.id === id);
}

/**
 * Built-in models already carry richer metadata than the models.dev snapshot —
 * cost and request `compat` included — so native providers skip `enrichModel`
 * entirely. `thinkingLevels` comes from the SDK so the composer's effort menu
 * matches what the provider actually accepts.
 */
function toProviderModel(model: Model<Api>): ProviderModel {
  // Keep only levels the shared vocabulary knows, so a future pi level cannot leak
  // into `models.json` / the composer before FastVibe has a label for it. `off` is
  // dropped with them: the SDK reports it for every model, but requesting it is what
  // makes a reason-by-default upstream answer with a 400.
  const supported = new Set<string>(THINKING_LEVELS);
  const levels = getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel =>
    supported.has(level) && level !== "off",
  );
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
    // A non-reasoning model reports only `["off"]`, which leaves nothing here, so the
    // composer keeps its default effort menu, matching the models.dev path.
    thinkingLevels: levels.length > 0 ? levels : undefined,
    // The SDK's built-ins carry list prices too, so the model dialog can show the
    // same numbers the app prices a run with.
    cost: hasPricing(model.cost) ? { ...model.cost } : undefined,
    source: "native",
  };
}

/** The SDK defaults an unknown price to all zeros, which means "no information". */
function hasPricing(cost: Model<Api>["cost"]): boolean {
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

/** The subset of a native provider's models the user chose to keep. */
export function selectedNativeModels(id: string, selectedIds: string[]): ProviderModel[] {
  const provider = findNativeProvider(id);
  if (!provider) return [];
  const wanted = new Set(selectedIds);
  return provider.models.filter((model) => wanted.has(model.id));
}

/**
 * Rebuild a selected native roster from the SDK catalog while retaining FastVibe's
 * user-edited metadata. Unedited rows deliberately come from the SDK so an upgrade can
 * refresh its defaults; edited rows only override the fields the detail dialog owns.
 */
export function mergeNativeModels(id: string, selected: ProviderModel[]): ProviderModel[] {
  const provider = findNativeProvider(id);
  if (!provider) return [];
  const saved = new Map(selected.map((model) => [model.id, model]));
  return provider.models
    .filter((model) => saved.has(model.id))
    .map((model) => {
      const override = saved.get(model.id);
      if (override?.edited !== true) return model;
      return {
        ...model,
        name: override.name,
        contextWindow: override.contextWindow,
        maxTokens: override.maxTokens,
        reasoning: override.reasoning,
        input: override.input,
        thinkingLevels: override.thinkingLevels,
        edited: true,
      };
    });
}
