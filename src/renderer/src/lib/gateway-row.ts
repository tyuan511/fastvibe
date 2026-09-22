import type { ProviderConfig } from "@shared/types";

/**
 * What the balance row should draw for a provider, as a pure decision.
 *
 * It is separate from the component because the same question has now been answered wrong
 * twice, both times by folding two unrelated ones together:
 *
 * - gating the row on `provider.gateway` alone hid it for every provider added before the
 *   probe existed, which is how the feature became undiscoverable;
 * - gating it on `kind === "custom"` hid the built-in FastVibe gateway, whose balance had
 *   just been made to work.
 *
 * Both were invisible to a typecheck and only showed up as a missing row, so the shape is
 * pinned here and tested.
 */
export type GatewayRowState = {
  /** Draw a value and a refresh: a known upstream and a credential to ask it with. */
  showValue: boolean;
  /** Draw a value at all. False means this provider has no panel to read. */
  readable: boolean;
  /**
   * The upstream is a new-api panel and no panel credential is stored, so there is nothing
   * to read *yet* — the row asks for one instead of making a request that would be refused.
   */
  needsCredential: boolean;
  /** Offer 识别上游: a custom endpoint nobody has identified. */
  offerIdentify: boolean;
};

export function gatewayRowState(provider: ProviderConfig): GatewayRowState {
  const identified = Boolean(provider.gateway);
  // A known upstream plus a credential — and a built-in counts: FastVibe's own gateway is a
  // Sub2API deployment whose panel answers for this install's key.
  const readable = identified && provider.hasKey;
  // new-api's wallet lives on a panel route, which a relay key cannot open.
  const needsCredential = provider.gateway === "new-api" && !provider.gatewayCredential;
  return {
    readable,
    needsCredential,
    showValue: readable && !needsCredential,
    // Only a custom endpoint can have an unknown upstream: a built-in's gateway is known
    // from the start, and a native provider's comes from the SDK.
    offerIdentify: provider.kind === "custom" && !identified && Boolean(provider.baseUrl),
  };
}
