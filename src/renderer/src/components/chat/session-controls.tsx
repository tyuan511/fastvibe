import type { ContextUsage } from "@shared/types";

/**
 * Context-window usage as a percentage, for the composer's ring.
 *
 * Takes the whole session state so the main thread and a 辅助对话 pass theirs
 * unchanged; a delegated run has no `EngineSessionState`, only its own
 * `contextUsage`, so the parameter is the one field that is actually read.
 */
export function usagePercent(state: { contextUsage?: ContextUsage | null } | null): number | null {
  const usage = state?.contextUsage;
  if (!usage) return null;
  if (usage.tokens != null && usage.contextWindow > 0) {
    return Math.min(999, (usage.tokens / usage.contextWindow) * 100);
  }
  if (usage.percent == null) return null;
  return usage.percent > 1.5 ? usage.percent : usage.percent * 100;
}
