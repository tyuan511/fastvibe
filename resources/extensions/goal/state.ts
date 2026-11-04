import { randomUUID } from "node:crypto";

// Goal semantics adapted from openai/codex f39e45e4a68db24c649a9b6b12d2e922cba616d1.
// See resources/extensions/goal/NOTICE.md for provenance and adaptation details.
export const GOAL_STATUSES = ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type Goal = {
  version: 2;
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};
export const GOAL_ENTRY = "fastvibe-goal";
export const GOAL_CONTEXT = "fastvibe-goal-context";
export const GOAL_CONTINUATION = "fastvibe-goal-continuation";

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function newGoal(objective: string, tokenBudget?: number, maximum?: number): Goal {
  if (!objective.trim()) throw new Error("A goal requires a non-empty objective.");
  tokenBudget ??= maximum;
  validateBudget(tokenBudget, maximum);
  const now = Date.now();
  return { version: 2, id: randomUUID(), objective: objective.trim(), status: "active", tokenBudget, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now };
}

export function validateBudget(value: unknown, maximum?: number): asserts value is number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) <= 0)) {
    throw new Error("token_budget must be a positive safe integer.");
  }
  if (maximum !== undefined) {
    validateBudget(maximum);
    if (typeof value === "number" && value > maximum) throw new Error(`Goal token budget ${value} exceeds the maximum allowed goal token budget of ${maximum}.`);
  }
}

/** Last record wins, including a clear tombstone. Accept legacy objectives without restarting them. */
export function restoreGoal(entries: Iterable<{ type: string; customType?: string; data?: unknown }>): Goal | null {
  let goal: Goal | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
    const data = entry.data as Partial<Goal> | null | undefined;
    if (data === null) { goal = null; continue; }
    if (!data || typeof data.objective !== "string" || !data.objective.trim()) continue;
    const status = GOAL_STATUSES.includes(data.status as GoalStatus) ? data.status as GoalStatus : "paused";
    const budget = typeof data.tokenBudget === "number" && Number.isSafeInteger(data.tokenBudget) && data.tokenBudget > 0 ? data.tokenBudget : undefined;
    goal = {
      version: 2, id: typeof data.id === "string" ? data.id : "legacy-goal",
      objective: data.objective, status, tokenBudget: budget,
      tokensUsed: count(data.tokensUsed), timeUsedSeconds: count(data.timeUsedSeconds),
      createdAt: count(data.createdAt), updatedAt: count(data.updatedAt),
    };
  }
  return goal;
}

/** Pi input excludes cached reads already. Count uncached input/cache writes + output, as Codex does. */
export function goalTokens(usage: unknown): number {
  const value = usage as { input?: number; output?: number; cacheWrite?: number } | undefined;
  return count(value?.input) + count(value?.cacheWrite) + count(value?.output);
}

export function isOverBudget(goal: Goal): boolean {
  return goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
}

export function goalResult(goal: Goal | null, completed = false): object {
  const remainingTokens = goal?.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed);
  const completionBudgetReport = completed && goal?.status === "complete" && (goal.tokenBudget !== undefined || goal.timeUsedSeconds > 0)
    ? "Goal achieved. Report final usage from this tool result's structured goal fields. If goal.tokenBudget is present, include goal.tokensUsed and goal.tokenBudget. If goal.timeUsedSeconds is greater than 0, summarize elapsed time concisely in the response language."
    : null;
  return { goal: goal ? { ...goal } : null, remainingTokens, completionBudgetReport };
}

export function escapeObjective(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
