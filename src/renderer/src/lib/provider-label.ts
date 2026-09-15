/**
 * Display name for a provider.
 *
 * Custom providers get an internal `custom-<slug>` id so their namespace can never
 * collide with a pi-coding-agent built-in. That prefix is an implementation detail:
 * strip it before anything reaches the UI. Pass the provider's `name` when it is
 * known — this helper only exists for surfaces that hold nothing but the id.
 */
export function providerLabel(value?: string | null): string {
  if (!value) return "";
  return value.replace(/^custom-/, "");
}
