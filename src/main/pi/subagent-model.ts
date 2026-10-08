import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Scheduling and execution must agree on the authenticated model actually used. */
export function resolveSubagentModel(registry: ModelRegistry | null, spec?: string, fallback?: string): ReturnType<ModelRegistry["find"]> {
  if (!registry) return undefined;
  const usable = (model: ReturnType<ModelRegistry["find"]>) =>
    Boolean(model) && registry.hasConfiguredAuth(model!);
  const bySpec = (value?: string): ReturnType<ModelRegistry["find"]> => {
    if (!value) return undefined;
    const slash = value.indexOf("/");
    const direct = slash > 0 ? registry.find(value.slice(0, slash), value.slice(slash + 1)) : undefined;
    if (usable(direct)) return direct;
    // A bare id (`claude-haiku-4-5`) resolves against the authenticated models only,
    // so a role's vendor default can never outrank the user's working model. The id
    // is re-checked for auth: `find`/`getAvailable` can surface a vendor entry whose
    // provider has no key in *this* install, which is exactly the "No API key found
    // for anthropic" failure a role's `model:` line used to cause.
    const bare = registry.getAvailable().find((item) => item.id === value);
    return usable(bare) ? bare : undefined;
  };
  return bySpec(spec) ?? bySpec(fallback);
}
