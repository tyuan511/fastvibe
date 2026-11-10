import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { uiText } from "../engine/ui-text.ts";

/** Review is explicitly configured; never fall back to a chat or another provider. */
export function resolveReviewModel(registry: ModelRegistry | null, spec?: string): NonNullable<ReturnType<ModelRegistry["find"]>> {
  const slash = spec?.indexOf("/") ?? -1;
  if (!spec || slash < 1 || slash === spec.length - 1) {
    throw new Error(uiText("请先在设置 → 子代理中选择 Review 审查模型", "Choose a Review model in Settings → Subagents first"));
  }
  const model = registry?.find(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model || !registry?.hasConfiguredAuth(model)) {
    throw new Error(uiText("预设的 Review 审查模型不可用，请检查模型和供应商配置", "The configured Review model is unavailable. Check its model and provider settings."));
  }
  return model;
}
