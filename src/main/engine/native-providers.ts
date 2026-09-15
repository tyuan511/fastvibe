import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { THINKING_LEVELS, type ProviderModel, type ThinkingLevel } from "@shared/types";

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
 * Native providers are **never** written to `models.json`. Their credential lives
 * in the engine's in-memory credential overlay under the provider id, and their
 * models already exist in the catalog. Writing them out would be actively harmful:
 * `models.json` resolves
 * `apiKey` as an environment-variable name, so an unresolvable name is sent as the
 * literal bearer token (`Authorization: Bearer FASTVIBE_KEY_OPENAI`).
 */

/**
 * Built-ins that a pasted API key cannot configure, so the UI must not offer one.
 *
 * `github-copilot` and `openai-codex` authenticate through a subscription OAuth
 * login, and `amazon-bedrock` / `google-vertex` resolve cloud credentials (AWS
 * profiles and `gcloud` application-default credentials) rather than a key. Every
 * other built-in is an ordinary API-key provider.
 */
const UNSUPPORTED: Record<string, string> = {
  "github-copilot": "需要 GitHub Copilot 订阅登录（OAuth），暂不支持",
  "openai-codex": "需要 ChatGPT Plus / Pro 订阅登录（OAuth），暂不支持",
  "amazon-bedrock": "使用 AWS 凭据（AWS_PROFILE / IAM），暂不支持",
  "google-vertex": "使用 Google 应用默认凭据（gcloud auth），暂不支持",
};

export type NativeProvider = {
  /** SDK provider id, e.g. `deepseek`. FastVibe uses it verbatim as the stored id. */
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  models: ProviderModel[];
  /** False when the provider needs OAuth or cloud credentials instead of a key. */
  supported: boolean;
  unsupportedReason?: string;
};

let cached: NativeProvider[] | null = null;

/** Every built-in provider the SDK knows about, alphabetical by display name. */
export function listNativeProviders(): NativeProvider[] {
  if (cached) return cached;

  const grouped = new Map<string, { name: string; api: string; baseUrl: string; models: ProviderModel[] }>();

  for (const provider of builtinProviders()) {
    const entry = grouped.get(provider.id) ?? { name: provider.name, api: "", baseUrl: "", models: [] };
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
      return {
        id,
        name: entry.name,
        api: entry.api,
        baseUrl: entry.baseUrl,
        models: entry.models.sort((a, b) => a.name.localeCompare(b.name)),
        supported: !reason,
        unsupportedReason: reason,
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
  // into `models.json` / the composer before FastVibe has a label for it.
  const supported = new Set<string>(THINKING_LEVELS);
  const levels = getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel =>
    supported.has(level),
  );
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
    // A non-reasoning model reports `["off"]`; treat that as "no explicit levels"
    // so the composer keeps its default effort menu, matching the models.dev path.
    thinkingLevels: levels.length > 1 ? levels : undefined,
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
