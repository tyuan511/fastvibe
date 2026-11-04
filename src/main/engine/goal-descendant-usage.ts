import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type GoalUsageEvent = { goalId: string; tokens: number };
export type GoalAccountingBridge = {
  setGoal(goalId: string | undefined): void;
  subscribe(listener: (event: GoalUsageEvent) => void): () => void;
};
type Scope = {
  goalId?: string;
  listener?: (event: GoalUsageEvent) => void;
  pending: Map<string, number>;
  draining: boolean;
};
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** A request owns its goal at dispatch, even if that goal stops before the reply arrives.
 * The extension persists deltas; this bridge retains only the brief reload/subscription gap.
 */
export class GoalDescendantUsage {
  #scopes = new Map<string, Scope>();

  bridge(conversationId: string): GoalAccountingBridge {
    let scope = this.#scopes.get(conversationId);
    if (!scope) {
      scope = { pending: new Map(), draining: false };
      this.#scopes.set(conversationId, scope);
    }
    const owned = scope;
    return {
      setGoal: (goalId) => {
        if (this.#scopes.get(conversationId) === owned) owned.goalId = goalId;
      },
      subscribe: (listener) => {
        if (this.#scopes.get(conversationId) !== owned) return () => {};
        // There is one goal extension per parent. A stale reload cleanup must not
        // unsubscribe its replacement or deliver a delta to two extension instances.
        owned.listener = listener;
        this.#drain(owned);
        return () => { if (owned.listener === listener) owned.listener = undefined; };
      },
    };
  }

  capture(conversationId: string): (usage: unknown) => void {
    const scope = this.#scopes.get(conversationId);
    const goalId = scope?.goalId;
    let reported = false;
    return (usage) => {
      if (reported) return;
      reported = true;
      if (!scope || !goalId || this.#scopes.get(conversationId) !== scope) return;
      const fields = usage as { input?: unknown; output?: unknown; cacheWrite?: unknown } | undefined;
      const tokens = count(fields?.input) + count(fields?.output) + count(fields?.cacheWrite);
      if (!tokens) return;
      scope.pending.set(goalId, (scope.pending.get(goalId) ?? 0) + tokens);
      this.#drain(scope);
    };
  }

  delete(conversationId: string): void { this.#scopes.delete(conversationId); }
  clear(): void { this.#scopes.clear(); }

  #drain(scope: Scope): void {
    if (scope.draining) return;
    scope.draining = true;
    try {
      for (const [goalId, tokens] of scope.pending) {
        if (!scope.listener) break;
        scope.pending.delete(goalId);
        try { scope.listener({ goalId, tokens }); }
        catch (error) {
          scope.pending.set(goalId, (scope.pending.get(goalId) ?? 0) + tokens);
          console.error("[goal] descendant usage delivery failed", error);
          break;
        }
      }
    } finally { scope.draining = false; }
  }
}

/** onPayload runs immediately before the provider request, unlike message_start,
 * which can arrive much later. Historical/forked messages never reach this pair.
 */
export function trackGoalDescendantUsage(
  session: Pick<AgentSession, "agent" | "subscribe">,
  capture: () => (usage: unknown) => void,
): () => void {
  const agent = session.agent;
  const forward = agent.onPayload;
  let report: ((usage: unknown) => void) | undefined;
  let disposed = false;
  const completedMessages = new WeakSet<object>();
  const onPayload: typeof agent.onPayload = async (payload, model) => {
    const result = await forward?.(payload, model);
    if (!disposed) report = capture();
    return result;
  };
  agent.onPayload = onPayload;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant" || completedMessages.has(event.message)) return;
    completedMessages.add(event.message);
    const completed = report;
    report = undefined;
    completed?.(event.message.usage);
  });
  return () => {
    disposed = true;
    report = undefined;
    unsubscribe();
    if (agent.onPayload === onPayload) agent.onPayload = forward;
  };
}
