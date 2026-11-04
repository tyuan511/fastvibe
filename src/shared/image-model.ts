import type { ImageModel, ImageProtocol } from "./image-generation.ts";
import type { ProviderApi, ProviderConfig } from "./types.ts";

export type ImageProviderApi = Extract<ProviderApi, `image-${string}`>;

export function isImageApi(api: unknown): api is ImageProviderApi {
  return api === "image-gpt" || api === "image-gemini" || api === "image-grok";
}

export function imageProtocolForApi(api: unknown): ImageProtocol | undefined {
  switch (api) {
    case "image-gpt": return "openai";
    case "image-gemini": return "gemini";
    case "image-grok": return "grok";
    default: return undefined;
  }
}

/** Configuration availability only: never probes a provider or accepts OAuth as a key. */
export function isUsableImageModel(model: ImageModel): boolean {
  const validId = (value: string): boolean => typeof value === "string" && value.trim().length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!model.enabled || !model.hasKey || !validId(model.id) || !validId(model.model)) return false;
  try {
    const url = new URL(model.baseUrl);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export function imageModelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Model protocols override the provider default, including an explicit chat protocol. */
export function imageModelsFromProviders(providers: ProviderConfig[]): ImageModel[] {
  return providers.flatMap((provider) => provider.models.flatMap((model) => {
    const protocol = imageProtocolForApi(model.api ?? provider.api);
    return protocol ? [{
      id: imageModelKey(provider.id, model.id), name: model.name, model: model.id,
      protocol, providerId: provider.id, baseUrl: provider.baseUrl,
      enabled: provider.enabled, hasKey: provider.hasKey,
    }] : [];
  }));
}
