import type { CostTier } from "@shared/types";

const DEFAULT_CONTEXT = 128_000;

/**
 * Long-context prices are usually split at a smaller first segment (for example,
 * 200K tokens followed by a more expensive rate). Keep a newly added model inside
 * that first segment by default, rather than silently selecting the provider's full
 * context window and surprising the user with the higher price.
 */
export function defaultContextWindow(catalogContext: number, costTiers?: CostTier[]): number {
  const context = catalogContext > 0 ? catalogContext : DEFAULT_CONTEXT;
  const firstTier = costTiers?.reduce<number | undefined>(
    (smallest, tier) => tier.over > 0 && (smallest === undefined || tier.over < smallest) ? tier.over : smallest,
    undefined,
  );
  if (firstTier === undefined) return context;
  return catalogContext > 0 ? Math.min(catalogContext, firstTier) : firstTier;
}
