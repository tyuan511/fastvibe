/**
 * Which backend the decision layer's `decide()` uses — see `docs/decision-layer.md` §5.3
 * and `src/main/engine/decision/`. There is no secret in this shape: Laya runs on the
 * user's own machine, so unlike a future Jev config (an API key) this is safe to hand a
 * renderer or a remote client whole, exactly as stored.
 */
export type DecisionModelConfig = { kind: "off" } | { kind: "laya"; baseUrl?: string };

export const DEFAULT_DECISION_MODEL: DecisionModelConfig = { kind: "off" };

/** What `~/code/laya/start.sh bg` (the local laya-mlx HTTP wrapper) listens on by default. */
export const DEFAULT_LAYA_BASE_URL = "http://127.0.0.1:8787";

export function validDecisionBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Normalizes an untrusted value (disk, IPC payload) into a config that is always one of the two known shapes. */
export function decisionModelConfigOf(value: unknown): DecisionModelConfig {
  if (typeof value !== "object" || value === null) return DEFAULT_DECISION_MODEL;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "laya") {
    const baseUrl = (value as { baseUrl?: unknown }).baseUrl;
    return validDecisionBaseUrl(baseUrl) ? { kind: "laya", baseUrl: baseUrl.trim() } : { kind: "laya" };
  }
  return DEFAULT_DECISION_MODEL;
}

export type DecisionTestResult = { ok: true; model?: string } | { ok: false; error: string };
