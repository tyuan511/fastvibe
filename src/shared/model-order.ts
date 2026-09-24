import type { ProviderModel } from "./types";

/** The label users see in a provider's model list. */
export function providerModelLabel(model: Pick<ProviderModel, "id" | "name">): string {
  return typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id;
}

const MODEL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Stable default ordering for models that have never been manually arranged. */
export function compareProviderModels(a: ProviderModel, b: ProviderModel): number {
  return MODEL_COLLATOR.compare(providerModelLabel(a), providerModelLabel(b)) || MODEL_COLLATOR.compare(a.id, b.id);
}

/**
 * Apply a user's saved ID order, putting models that were added later after the
 * existing entries in normal alphabetical order. Without a saved order the entire
 * list is alphabetical.
 */
export function orderProviderModels(models: ProviderModel[], modelOrder?: string[]): ProviderModel[] {
  const ordered = [...models];
  if (!modelOrder || modelOrder.length === 0) return ordered.sort(compareProviderModels);

  const positions = new Map<string, number>();
  for (const id of modelOrder) {
    if (!positions.has(id)) positions.set(id, positions.size);
  }
  return ordered.sort((a, b) => {
    const aPosition = positions.get(a.id);
    const bPosition = positions.get(b.id);
    if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition;
    if (aPosition !== undefined) return -1;
    if (bPosition !== undefined) return 1;
    return compareProviderModels(a, b);
  });
}
