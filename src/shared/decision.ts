/**
 * Which decision model browser use runs on — see `docs/decision-layer.md` §5.2 and
 * `src/main/engine/decision/`. `off` keeps browser use on the `browser_*` tools the main
 * model drives; `jev` / `laya` add the `browser_task` loop. There is no secret in this
 * shape — Jev's key lives in the agent `.env` under `JEV_KEY_ENV`, never here — so it is
 * safe to hand a renderer or a remote client whole, exactly as stored.
 */
export type DecisionModelConfig = { kind: "off" } | { kind: "jev" } | { kind: "laya"; baseUrl?: string };

/** The fixed `.env` variable holding the Jev API key; callers never choose a variable name. */
export const JEV_KEY_ENV = "FASTVIBE_JEV_API_KEY";

/** Whether each keyed decision model has a stored key. The key itself never leaves Main. */
export type DecisionKeyState = { jev: boolean };

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
  if (kind === "jev") return { kind: "jev" };
  if (kind === "laya") {
    const baseUrl = (value as { baseUrl?: unknown }).baseUrl;
    return validDecisionBaseUrl(baseUrl) ? { kind: "laya", baseUrl: baseUrl.trim() } : { kind: "laya" };
  }
  return DEFAULT_DECISION_MODEL;
}

export type DecisionTestResult = { ok: true; model?: string } | { ok: false; error: string };
