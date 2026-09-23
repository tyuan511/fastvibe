/**
 * Which decision model browser use runs on — see `docs/decision-layer.md` §5.2 and
 * `src/main/engine/decision/`. `off` keeps browser use on the `browser_*` tools the main
 * model drives; `jev` adds the `browser_task` loop when `browserControl` is on, and the
 * `computer_task` loop when `computerControl` is on.
 * There is no secret in this shape — Jev's key lives in the agent `.env` under
 * `JEV_KEY_ENV`, never here — so it is safe to hand a renderer or a remote client whole.
 */
export type DecisionModelConfig = {
  kind: "off" | "jev";
  /** Offer `browser_task`. Absent on older files: on only when Jev was already selected. */
  browserControl: boolean;
  /**
   * Offer `computer_task`. Absent on older files means off: driving desktop windows is
   * new, and a switch nobody turned on must not start doing it.
   */
  computerControl: boolean;
};

/** The fixed `.env` variable holding the Jev API key; callers never choose a variable name. */
export const JEV_KEY_ENV = "FASTVIBE_JEV_API_KEY";

/** Whether each keyed decision model has a stored key. The key itself never leaves Main. */
export type DecisionKeyState = { jev: boolean };

export const DEFAULT_DECISION_MODEL: DecisionModelConfig = { kind: "off", browserControl: false, computerControl: false };

/**
 * Normalizes an untrusted value (disk, IPC payload) into one of the known shapes.
 * Anything else — including `{ kind: "laya" }` from the builds that offered the local
 * Laya model, removed for being unable to hold a web page in its 512-token window —
 * reads as off. A file written before `browserControl` existed keeps the tool on for Jev.
 */
export function decisionModelConfigOf(value: unknown): DecisionModelConfig {
  if (typeof value !== "object" || value === null) return DEFAULT_DECISION_MODEL;
  const record = value as { kind?: unknown; browserControl?: unknown; computerControl?: unknown };
  const kind = record.kind === "jev" ? "jev" : "off";
  return {
    kind,
    browserControl: typeof record.browserControl === "boolean" ? record.browserControl : kind === "jev",
    computerControl: record.computerControl === true,
  };
}

export type DecisionTestResult = { ok: true; model?: string } | { ok: false; error: string };
