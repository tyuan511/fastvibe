/**
 * Which decision model runs, and for what — see `docs/decision-layer.md` §5.2 and
 * `src/main/engine/decision/`. `off` keeps browser use on the `browser_*` tools the main
 * model drives and every other scenario on its default path; `jev` turns on each scenario
 * whose switch is set: the `browser_task` loop (`browserControl`), the `computer_task`
 * loop (`computerControl`), the `batch_decide` tool (`batchDecide`), the 帮我批准
 * judgement (`smartApproval`) and enhanced memory (`memoryControl`).
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
  /** Offer `batch_decide` to the main agent. Absent means off. */
  batchDecide: boolean;
  /**
   * Let the decision model judge tool calls in 帮我批准 mode. Absent means off, and off
   * is the sandbox's own pattern rules — a permission gate nobody chose must not change.
   */
  smartApproval: boolean;
  /** Let Jev make typing, relation, consolidation and retrieval decisions for enhanced memory. */
  memoryControl?: boolean;
};

/** The fixed `.env` variable holding the Jev API key; callers never choose a variable name. */
export const JEV_KEY_ENV = "FASTVIBE_JEV_API_KEY";

/** Whether each keyed decision model has a stored key. The key itself never leaves Main. */
export type DecisionKeyState = { jev: boolean };

export const DEFAULT_DECISION_MODEL: DecisionModelConfig = {
  kind: "off",
  browserControl: false,
  computerControl: false,
  batchDecide: false,
  smartApproval: false,
};

/** The per-scenario switches, in the order 设置 → 决策引擎 › 应用场景 lists them. */
export const DECISION_SCENARIOS = ["browserControl", "computerControl", "batchDecide", "smartApproval", "memoryControl"] as const;
export type DecisionScenario = (typeof DECISION_SCENARIOS)[number];

/**
 * Normalizes an untrusted value (disk, IPC payload) into one of the known shapes.
 * Anything else — including `{ kind: "laya" }` from the builds that offered the local
 * Laya model, removed for being unable to hold a web page in its 512-token window —
 * reads as off. A file written before `browserControl` existed keeps the tool on for Jev.
 */
export function decisionModelConfigOf(value: unknown): DecisionModelConfig {
  if (typeof value !== "object" || value === null) return DEFAULT_DECISION_MODEL;
  const record = value as { kind?: unknown; browserControl?: unknown; computerControl?: unknown; batchDecide?: unknown; smartApproval?: unknown; memoryControl?: unknown };
  const kind = record.kind === "jev" ? "jev" : "off";
  return {
    kind,
    browserControl: typeof record.browserControl === "boolean" ? record.browserControl : kind === "jev",
    computerControl: record.computerControl === true,
    batchDecide: record.batchDecide === true,
    smartApproval: record.smartApproval === true,
    ...(typeof record.memoryControl === "boolean" ? { memoryControl: record.memoryControl } : {}),
  };
}

export type DecisionTestResult = { ok: true; model?: string } | { ok: false; error: string };
