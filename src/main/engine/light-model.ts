import type { EngineModel } from "@shared/types";

/**
 * The part of the engine's model registry these rules need.
 *
 * Structural rather than `ModelRegistry`, so the ordering can be pinned by a test
 * without an engine, a provider, or a request that would bill the user for it.
 */
export type LightModelRegistry<M> = {
  find(provider: string, id: string): M | undefined;
  hasConfiguredAuth(model: M): boolean;
};

/**
 * The model pinned as 轻量模型 (设置 → 模型), when this install can authenticate it.
 *
 * `undefined` means the setting has no opinion — which is its default, and what every
 * one of these jobs did before the pin existed. A pin whose provider was deleted, or
 * whose model was dropped by 同步模型, is not an error worth raising on a side job: the
 * caller's own model answers instead, so a chat still gets a title.
 */
export function pinnedLightModel<M>(
  registry: LightModelRegistry<M> | undefined,
  pinned: EngineModel | undefined,
): M | undefined {
  if (!registry || !pinned) return undefined;
  const model = registry.find(pinned.provider, pinned.id);
  return model && registry.hasConfiguredAuth(model) ? model : undefined;
}

/**
 * The model one lightweight request should use: the pinned 轻量模型 when it is usable,
 * else the model of the conversation that asked.
 *
 * `sessionModel` is handed back as it came, credentials and all — the callers keep
 * validating it themselves (`hasConfiguredAuth`, or the 「还没有可用的模型」 a commit
 * subject raises), so this rule cannot quietly move a chat with no working model onto a
 * request that fails somewhere else instead.
 */
export function lightModelFor<M>(
  registry: LightModelRegistry<M> | undefined,
  pinned: EngineModel | undefined,
  sessionModel: M | undefined,
): M | undefined {
  return pinnedLightModel(registry, pinned) ?? sessionModel;
}
