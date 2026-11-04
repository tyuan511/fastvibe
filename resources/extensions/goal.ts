import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { executionUnavailable, GoalClock } from "./goal/progress";
import { escapeObjective, GOAL_CONTEXT, GOAL_CONTINUATION, GOAL_ENTRY, goalResult, goalTokens, isOverBudget, newGoal, restoreGoal, validateBudget, type Goal, type GoalStatus } from "./goal/state";

const continuationTemplate = readFileSync(new URL("./goal/continuation.md", import.meta.url), "utf8");
const budgetTemplate = readFileSync(new URL("./goal/budget_limit.md", import.meta.url), "utf8");
const T = (zh: string, en: string): string => process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh;
const UPDATE_DESCRIPTION = `Update the existing goal.
Set status to paused only at the user's explicit request to pause this goal, never on your own initiative. A later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.
Set status to complete only when the full objective has actually been achieved and no required work remains. Verify every requirement against current authoritative evidence; a plausible final answer, partial implementation or narrow passing test is not proof.
Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns (including the original/user-triggered turn) and meaningful progress requires user input or an external-state change. After resume, start a fresh blocked audit. Do not use blocked merely because work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Once that threshold is met, set blocked instead of repeating status reports while leaving the goal active.
You cannot resume, budget-limit or usage-limit a goal with this tool. Do not mark a goal complete because its budget is nearly exhausted. For a budgeted completed goal, report the final token usage from the tool result.`;

type DescendantAccounting = {
  setGoal(goalId: string | undefined): void;
  subscribe(listener: (event: { goalId: string; tokens: number }) => void): () => void;
};

/** Codex goal lifecycle, adapted to Pi's transactional pre-settlement boundary. */
export default function goalMode(pi: ExtensionAPI): void {
  let goal: Goal | null = null;
  let armed = false;
  let requestGoalId: string | undefined;
  const clock = new GoalClock();
  let accounting: DescendantAccounting | undefined;
  let unsubscribe: (() => void) | undefined;
  let emptyTurns = 0;
  let automaticTurn = false;
  let executionFailures = 0;
  let failedExecution = false;
  let successfulTool = false;
  let turnHadActivity = false;
  let budgetWrapUp = false;
  let lastAssistant: { stopReason?: string; errorMessage?: string; content?: unknown[] } | undefined;

  pi.registerFlag("max-goal-token-budget", { type: "string", description: "Optional maximum/default token budget for a goal", default: process.env.FASTVIBE_MAX_GOAL_TOKEN_BUDGET });
  const maximumBudget = (): number | undefined => {
    const value = pi.getFlag("max-goal-token-budget");
    if (value === undefined) return undefined;
    const maximum = Number(value);
    validateBudget(maximum);
    return maximum;
  };
  const resetAudit = (): void => { emptyTurns = 0; automaticTurn = false; executionFailures = 0; failedExecution = false; successfulTool = false; };
  const sampleTime = (): void => {
    const seconds = clock.sample(goal?.status === "active" || budgetWrapUp);
    if (goal) goal = { ...goal, timeUsedSeconds: seconds };
  };
  const publish = (ctx: ExtensionContext): void => {
    accounting?.setGoal(goal?.status === "active" || budgetWrapUp ? goal?.id : undefined);
    ctx.ui.setStatus("goal", goal ? JSON.stringify(goal) : undefined);
    ctx.ui.setStatus("goal-armed", armed ? "armed" : undefined);
  };
  const save = (ctx: ExtensionContext): void => {
    sampleTime();
    if (goal) goal = { ...goal, updatedAt: Date.now() };
    // Clear is a durable tombstone, so neither reload nor history navigation revives it.
    pi.appendEntry<Goal | null>(GOAL_ENTRY, goal ? { ...goal } : null);
    publish(ctx);
  };
  const setStatus = (status: GoalStatus, ctx: ExtensionContext): void => {
    if (!goal) return;
    sampleTime();
    goal = { ...goal, status };
    if (status !== "active") { budgetWrapUp = false; resetAudit(); }
    save(ctx);
  };
  const render = (template: string): string => {
    if (!goal) return "";
    const vars: Record<string, string> = {
      objective: escapeObjective(goal.objective), tokens_used: String(goal.tokensUsed),
      token_budget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
      remaining_tokens: goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed)),
      time_used_seconds: String(goal.timeUsedSeconds),
    };
    return template.replace(/{{ (\w+) }}/g, (_, key: string) => vars[key] ?? "");
  };
  const result = (completed = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(goalResult(goal, completed)) }], details: goalResult(goal, completed) });
  const addTokens = (tokens: number, ctx: ExtensionContext): void => {
    if (!goal) return;
    goal = { ...goal, tokensUsed: goal.tokensUsed + tokens };
    if (goal.status !== "complete" && isOverBudget(goal)) {
      if (goal.status === "active") budgetWrapUp = !ctx.isIdle();
      goal.status = "budget_limited";
    }
    save(ctx);
  };
  const create = (objective: string, budget: number | undefined, ctx: ExtensionContext): void => {
    if (goal && goal.status !== "complete") throw new Error(T("已有未完成目标，请先清除它或继续执行。", "An unfinished goal exists. Clear or resume it first."));
    goal = newGoal(objective, budget, maximumBudget());
    resetAudit();
    budgetWrapUp = false;
    clock.reset();
    armed = false;
    save(ctx);
  };
  const start = async (ctx: ExtensionCommandContext): Promise<void> => {
    // Hidden internal continuation, never a synthetic user message or title/preview.
    pi.sendMessage({ customType: GOAL_CONTINUATION, content: "Continue working toward the active thread goal.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
    for (let i = 0; i < 20 && ctx.isIdle(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  pi.registerTool({
    name: "get_goal", label: T("读取目标", "Read goal"),
    description: "Get the current goal for this conversation, including status, token budget, uncached token usage (including descendant agents), active elapsed time and remaining tokens.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { if (goal) save(ctx); return result(); },
  });
  pi.registerTool({
    name: "create_goal", executionMode: "sequential", label: T("创建目标", "Create goal"),
    description: "Create a persistent goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when explicitly requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: Type.Object({ objective: Type.String({ minLength: 1 }), token_budget: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, params, _signal, _update, ctx) { create(params.objective, params.token_budget, ctx); return result(); },
  });
  pi.registerTool({
    name: "update_goal", executionMode: "sequential", label: T("更新目标", "Update goal"), description: UPDATE_DESCRIPTION,
    parameters: Type.Object({ status: StringEnum(["complete", "blocked", "paused"] as const) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!goal) throw new Error("No goal is set.");
      setStatus(params.status === "complete" ? "complete" : isOverBudget(goal) ? "budget_limited" : params.status, ctx);
      return result(params.status === "complete");
    },
  });

  pi.registerCommand("goal", {
    description: T("设置持续目标（/goal <目标>，pause|resume|clear|budget <Token 数>）", "Set a persistent goal (/goal <objective>, pause|resume|clear|budget <tokens>)"),
    handler: async (args, ctx) => {
      const text = args.trim();
      const command = text.toLowerCase();
      if (!text) {
        if (goal) ctx.ui.notify(`${goal.objective}\n${goal.status} · ${goal.tokensUsed}${goal.tokenBudget === undefined ? "" : ` / ${goal.tokenBudget}`} tokens`, "info");
        else { armed = !armed; publish(ctx); }
        return;
      }
      if (["clear", "off", "none", "reset"].includes(command)) {
        goal = null; armed = false; requestGoalId = undefined; resetAudit(); budgetWrapUp = false; clock.reset();
        save(ctx);
        return;
      }
      if (command === "pause") {
        armed = false;
        if (goal?.status === "active") setStatus("paused", ctx);
        else publish(ctx);
        if (!ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
        return;
      }
      if (command === "resume") {
        if (!goal) { ctx.ui.notify(T("尚未设置目标。", "No goal is set."), "warning"); return; }
        if (goal.status === "complete" || goal.status === "active") return;
        await ctx.waitForIdle();
        // The awaited run may have cleared/replaced the goal or changed its status.
        const current = goal as Goal | null;
        if (!current || current.status === "complete" || current.status === "active") return;
        if (isOverBudget(current)) { ctx.ui.notify(T("目标预算已用完，请先用 /goal budget <Token 数> 增加总预算。", "Increase the total budget with /goal budget <tokens> before resuming."), "warning"); return; }
        goal = { ...current, status: "active" };
        resetAudit();
        save(ctx);
        await start(ctx);
        return;
      }
      if (/^budget(?:\s|$)/i.test(text)) {
        if (!goal) throw new Error(T("尚未设置目标。", "No goal is set."));
        const budget = Number(text.slice(6).trim());
        validateBudget(budget, maximumBudget());
        sampleTime();
        resetAudit();
        goal = { ...goal, tokenBudget: budget };
        if (isOverBudget(goal) && goal.status === "active") { goal.status = "budget_limited"; budgetWrapUp = !ctx.isIdle(); }
        else if (!isOverBudget(goal) && goal.status === "budget_limited") { goal.status = "paused"; budgetWrapUp = false; }
        save(ctx);
        return;
      }
      create(text, undefined, ctx);
      // Keep the user's objective visible in the transcript exactly once.
      pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      for (let i = 0; i < 20 && ctx.isIdle(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    // The goal belongs to the conversation, independently of the selected history.
    goal = restoreGoal(ctx.sessionManager.getEntries());
    armed = false; requestGoalId = undefined; resetAudit(); budgetWrapUp = false;
    clock.reset(goal?.timeUsedSeconds);
    sampleTime();
    publish(ctx);
  };
  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    accounting = (ctx.ui as typeof ctx.ui & { goalAccounting?: () => DescendantAccounting }).goalAccounting?.();
    restore(ctx);
    unsubscribe = accounting?.subscribe(({ goalId, tokens }) => {
      // A request captured the target at its start. Late results never charge a replacement.
      if (goal?.id === goalId && Number.isFinite(tokens) && tokens > 0) addTokens(tokens, ctx);
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (goal) save(ctx);
    clock.sample(false);
    unsubscribe?.(); unsubscribe = undefined;
    // Reload can overlap a child's next request. Keep its capture scope until the
    // new instance restores the persisted status; Main clears deleted/stopped hosts.
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", (event, ctx) => {
    if (armed && event.messageType === "user" && event.prompt.trim() && !event.prompt.trim().startsWith("/")) create(event.prompt, undefined, ctx);
  });

  // Context is rebuilt for EVERY request (tools, Continue, compaction and reload),
  // not only before_agent_start. There is only one fresh goal snapshot in the request.
  pi.on("context", (event) => {
    const messages = event.messages.filter((m) => !(m.role === "custom" && (m.customType === GOAL_CONTEXT || m.customType === GOAL_CONTINUATION)));
    sampleTime();
    const budgetContext = goal?.status === "budget_limited" && budgetWrapUp;
    requestGoalId = goal?.status === "active" || budgetContext ? goal?.id : undefined;
    if (!goal || (goal.status !== "active" && !budgetContext)) return { messages };
    const content = render(goal.status === "active" ? continuationTemplate : budgetTemplate);
    return { messages: [...messages, { role: "custom" as const, customType: GOAL_CONTEXT, content, display: false, timestamp: Date.now() }] };
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user") { automaticTurn = false; emptyTurns = 0; }
  });
  pi.on("agent_start", () => { lastAssistant = undefined; turnHadActivity = false; failedExecution = false; successfulTool = false; });
  pi.on("tool_execution_end", (event, ctx) => {
    turnHadActivity = true;
    emptyTurns = 0;
    if (!goal || goal.status !== "active") return;
    if (!event.isError) { successfulTool = true; executionFailures = 0; }
    else if (executionUnavailable(event)) failedExecution = true;
    save(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    lastAssistant = event.message;
    turnHadActivity ||= event.message.content.some((block) => block.type === "toolCall" || (block.type === "text" && Boolean(block.text.trim())) || (block.type === "thinking" && Boolean(block.thinking.trim())));
    if (!goal || requestGoalId !== goal.id) return;
    // The next request receives budget steering; an executing tool is never aborted.
    addTokens(goalTokens(event.message.usage), ctx);
    requestGoalId = undefined;
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (!goal || goal.status !== "active") return;
    if (event.outcome === "aborted") { setStatus("paused", ctx); return; }
    if (event.outcome === "error") {
      const limit = /insufficient_quota|usage.limit|quota.exceeded|billing|credit.balance/i.test(lastAssistant?.errorMessage ?? "");
      setStatus(limit ? "usage_limited" : "blocked", ctx);
      return;
    }
    if (isOverBudget(goal)) { setStatus("budget_limited", ctx); return; }
    if (failedExecution && !successfulTool) executionFailures++;
    if (executionFailures >= 3) { setStatus("blocked", ctx); return; }
    emptyTurns = automaticTurn && !turnHadActivity && lastAssistant?.stopReason === "stop" ? emptyTurns + 1 : 0;
    if (emptyTurns >= 3) { setStatus("blocked", ctx); return; }
    automaticTurn = true;
    save(ctx);
    // Pi runs this AFTER retry/compaction recovery and queued user messages. The
    // boundary commits a hidden input atomically and keeps one run busy until done.
    // No GOAL_COMPLETE parsing, user-message injection, or arbitrary round cap.
    return {
      entries: [{ type: "custom_message" as const, customType: GOAL_CONTINUATION, content: "Continue working toward the active thread goal.", display: false }],
      continue: true,
    };
  });
  pi.on("agent_settled", (event, ctx) => {
    sampleTime();
    budgetWrapUp = false;
    // Abort during retry backoff can bypass before-settle entirely.
    if (event.aborted && goal?.status === "active") setStatus("paused", ctx);
    else if (goal) save(ctx);
  });
}
