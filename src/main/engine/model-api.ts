import type { ProviderApi } from "@shared/types";

/**
 * Pick a per-model protocol override for models whose ids identify a native API.
 * The override is omitted when the provider already uses that protocol, so the
 * stored model can keep inheriting the provider default.
 */
export function automaticModelApi(id: string, providerApi?: string): ProviderApi | undefined {
  if (/^claude-/i.test(id.trim()) && providerApi !== "anthropic-messages") {
    return "anthropic-messages";
  }
  return undefined;
}
