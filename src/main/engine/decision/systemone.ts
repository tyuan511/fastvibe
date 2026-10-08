import { readDecisionConfig } from "./store";
import { loadProviderKeys, readProviders } from "../providers";
import { trimBaseUrl } from "../provider-url";
import type { FastVibePaths } from "../paths";

/** A model speaks System One when its own protocol says so, or it inherits the provider's. */
export function isSystemOneModel(providerApi: string, modelApi?: string): boolean {
  return (modelApi ?? providerApi) === "systemone";
}

/**
 * Where a System One provider's decide call goes.
 *
 * The stored base is the version root (`https://host/v1`), the same shape the other
 * API formats use, and this protocol's method is `/systemone` under it. A base that
 * already ends in that method is left alone, so pointing the provider at the full
 * URL still works.
 */
export function systemOneEndpoint(baseUrl: string): string {
  const base = trimBaseUrl(baseUrl);
  return base.endsWith("/systemone") ? base : `${base}/systemone`;
}

export type ResolvedSystemOne = {
  apiKey: string;
  endpoint: string;
  model: string;
};

/**
 * The System One model 决策引擎 selected, with the key and endpoint of its provider.
 *
 * Absent when the engine is off, the model was removed, its protocol is no longer
 * System One, or the provider has no key. Callers that also need a scenario switch
 * (增强记忆) check that themselves.
 */
export async function resolveSystemOne(paths: FastVibePaths): Promise<ResolvedSystemOne | undefined> {
  const selected = readDecisionConfig(paths.decisionFile);
  if (selected.kind !== "jev" || !selected.model) return undefined;
  const provider = readProviders(paths).find((item) => item.id === selected.model?.provider && item.enabled);
  if (!provider) return undefined;
  const model = provider.models.find((item) => item.id === selected.model?.id);
  if (!model || !isSystemOneModel(provider.api, model.api)) return undefined;
  const key = (await loadProviderKeys(paths))[provider.apiKeyEnv];
  if (!key) return undefined;
  return { apiKey: key, endpoint: systemOneEndpoint(provider.baseUrl), model: model.id };
}
