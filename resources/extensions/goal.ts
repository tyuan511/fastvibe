import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * FastVibe's built-in goal mode — a lean replacement for `pi-goal-x`.
 *
 *   /goal <objective>   start pursuing a long-term objective
 *   /goal pause         stop the execution loop
 *   /goal resume        continue a paused objective
 *   /goal clear         drop the objective
 *   /goal               report the current objective
 *
 * Each turn is prompted to compare progress against the objective and list that
 * round's tasks. When the agent finishes a turn without declaring the goal done
 * (a final `GOAL_COMPLETE` marker, stripped before rendering) the loop queues the
 * next round, so a task that needs many turns runs itself to the end. The
 * composer's panel reads the `goal` status payload.
 *
 * The objective belongs to *this* conversation, so it is persisted as a session
 * entry (not in memory, not in a renderer store): a reopened chat gets its goal
 * back from its own transcript. A goal can only run while the user is there to
 * watch it, though — a restart re-opens the goal **paused**, so nothing resumes
 * working behind the user's back after an app relaunch.
 */
const STATUS_KEY = "goal";
/** Armed-but-not-started state: shows the composer badge, not the objective panel. */
const ARMED_STATUS_KEY = "goal-armed";
const COMPLETE_MARKER = "GOAL_COMPLETE";
/** Session entry type the objective is persisted under (one per change). */
const ENTRY_TYPE = "fastvibe-goal";
/**
 * Rounds a goal may run before it pauses itself and waits for the user.
 *
 * The loop is autonomous and spends the user's tokens, so it needs a stop it does not
 * have to be asked for. It counts one *uninterrupted stretch* — set the goal, or hit
 * 继续, and the count starts again — rather than the goal's lifetime, because a cap
 * that a resume could not clear would make 继续 buy exactly one round. Reaching it is
 * a *pause* rather than an end: 继续 carries on from the same objective and round.
 */
const ROUND_CAP = 100;
const OFF = new Set(["clear", "off", "none", "reset"]);
const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);

type GoalState = "running" | "paused" | "complete";

/** What is written to the session (and therefore what a reopen restores). */
type GoalRecord = { objective: string; status: GoalState; round: number };

/**
 * How the run that just ended stopped, from its last assistant message.
 *
 * `agent_end` hands extensions the run's whole message list; the last assistant
 * message's `stopReason` is `stop` / `toolUse` / `length` on a turn that finished
 * (whether or not it wrote `GOAL_COMPLETE`), and `error` / `aborted` on one that did
 * not. A missing or unreadable message reads as a clean stop, so an unexpected
 * payload can never be mistaken for a reason to abandon the goal.
 */
function lastAssistantStopReason(event: AgentEndEvent): string | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; stopReason?: unknown };
    if (message?.role !== "assistant") continue;
    return typeof message.stopReason === "string" ? message.stopReason : undefined;
  }
  return undefined;
}

export default function goalMode(pi: ExtensionAPI): void {
  let objective: string | null = null;
  /** `/goal` was picked without an objective; the next user message becomes it. */
  let armed = false;
  let status: GoalState = "running";
  /** 1-based number of the round the agent is on (the panel shows this one). */
  let round = 1;
  /**
   * Rounds run since the user last set or resumed this goal, against `ROUND_CAP`.
   *
   * Reset by `/goal <objective>` and `/goal resume`, so the cap limits how long the
   * goal may work *unattended* without also making 继续 useless: after a pause the
   * next stretch starts over, while `round` keeps counting up for the panel.
   */
  let autonomous = 0;
  let completed = false;
  /**
   * The last settled turn failed, and the run has not started another attempt since.
   *
   * Set at `agent_end` when that turn stopped with an error, cleared at `agent_start`.
   * The SDK retries a transient failure *inside the same run* — it fires `agent_end`
   * first and then drops the errored message while it backs off — so the failure is
   * only terminal if the run settles without another `agent_start` having happened.
   * That is why the verdict is taken at `agent_settled` rather than here.
   */
  let failed = false;

  const publish = (ctx: ExtensionContext): void => {
    if (objective) {
      ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ objective, status, round }));
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    ctx.ui.setStatus(ARMED_STATUS_KEY, armed ? "armed" : undefined);
  };

  /**
   * Persist the goal on the session.
   *
   * Fire-and-forget: the entry is not context, it is what a later reopen reads
   * back, so nothing waits on it. It also stands on its own after a `/goal clear`
   * (nothing is written for "no goal") — the last record wins when read back.
   */
  const remember = (): void => {
    if (!objective) return;
    pi.appendEntry<GoalRecord>(ENTRY_TYPE, { objective, status, round });
  };

  const apply = (record: GoalRecord): void => {
    objective = record.objective;
    status = record.status;
    round = record.round;
  };

  /**
   * Restore this conversation's goal from its own transcript.
   *
   * The last record wins, so a restart gets back whatever the goal was when the
   * app was closed. It comes back **paused** whenever it was running: a goal is a
   * long autonomous loop that spends the user's tokens, and re-opening a chat (or
   * relaunching) must not silently resume one. `complete` stays complete — there
   * is nothing to resume.
   */
  const restore = (ctx: ExtensionContext, pause: boolean): void => {
    let record: GoalRecord | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as Partial<GoalRecord> | undefined;
      if (!data || typeof data.objective !== "string" || !data.objective) continue;
      const state: GoalState =
        data.status === "paused" || data.status === "complete" ? data.status : "running";
      // A round was written 1-based; an old record with 0 means the same thing.
      const roundNo = typeof data.round === "number" && data.round > 1 ? data.round : 1;
      record = { objective: data.objective, status: state, round: roundNo };
    }
    if (!record) return;
    apply(record);
    if (pause && status === "running") {
      status = "paused";
      pi.appendEntry<GoalRecord>(ENTRY_TYPE, { objective: record.objective, status, round });
    }
    publish(ctx);
  };

  const instructions = (): string => {
    return [
      "## 长期目标",
      `最终目标：${objective}`,
      `当前是第 ${round} 轮。请先对照最终目标评估当前进展，列出本轮需要完成的任务，然后完成它们。`,
      `如果目标已完全达成，请在最后一条消息的最后一行单独输出 ${COMPLETE_MARKER}。`,
    ].join("\n");
  };

  const continuePrompt = (): string =>
    "继续执行目标。对照最终目标检查当前进展，列出并完成下一批任务；若目标已完全达成，请在最后一行输出 GOAL_COMPLETE。";

  /**
   * Start a goal turn from a slash command and do not return while it is still idle.
   *
   * `pi.sendUserMessage` does not return the prompt promise — the SDK fires it and
   * swallows a failure. 0.87.1 only marks the session busy after several awaits, so a
   * command that returned immediately left `prompt("/goal …")` idle. The host's
   * `waitForIdle()` then saw nothing in flight and the goal never ran.
   */
  const armTurn = async (
    ctx: ExtensionCommandContext,
    text: string,
    deliverAs?: "followUp",
  ): Promise<void> => {
    pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
    for (let i = 0; i < 20 && ctx.isIdle(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  pi.registerCommand("goal", {
    description: "设置或控制长期目标（/goal <目标>，/goal pause|resume|clear）",
    handler: async (args, ctx) => {
      const text = args.trim();
      const command = text.toLowerCase();
      if (!text) {
        // Picked from the composer palette without an objective: arm goal mode and
        // show a badge (like plan mode) instead of asking inline. The objective is
        // the user's next message, so nothing runs until they actually send one.
        if (!objective) {
          armed = !armed;
          publish(ctx);
          return;
        }
        ctx.ui.notify(`目标（${status}，第 ${round} 轮）：${objective}`, "info");
        return;
      }
      if (OFF.has(command)) {
        objective = null;
        armed = false;
        status = "running";
        round = 1;
        autonomous = 0;
        completed = false;
        publish(ctx);
        return;
      }
      if (command === "pause") {
        if (!objective) {
          ctx.ui.notify(T("尚未设置目标。", "No goal is set."), "warning");
          return;
        }
        status = "paused";
        remember();
        publish(ctx);
        ctx.ui.notify(T("目标已暂停。", "Goal paused."), "info");
        return;
      }
      if (command === "resume") {
        if (!objective) {
          ctx.ui.notify(T("尚未设置目标。", "No goal is set."), "warning");
          return;
        }
        if (status === "paused") {
          status = "running";
          // The user is here again: this is a new unattended stretch, so the cap starts
          // over rather than ending the goal one round after every 继续.
          autonomous = 0;
          remember();
          publish(ctx);
          ctx.ui.notify(T("目标已继续。", "Goal resumed."), "info");
          // Same `deliverAs` rule as the loop below: the command runs on a session the
          // engine may still be mid-run on, and a plain prompt would be refused there.
          await armTurn(ctx, continuePrompt(), "followUp");
        }
        return;
      }
      objective = text;
      armed = false;
      status = "running";
      round = 1;
      autonomous = 0;
      completed = false;
      remember();
      publish(ctx);
      await armTurn(ctx, T(`开始执行目标：${text}`, `Start working towards the goal: ${text}`));
    },
  });

  pi.on("session_start", (event: SessionStartEvent, ctx) => {
    // A `/goal` picked from the palette arms an in-memory toggle; a brand-new
    // session has nothing armed and nothing to restore. An in-place `reload` is the
    // *same* session being re-bound (a provider edit, a metadata refresh), so it must
    // not count as coming back from a restart and pause a goal that is still running.
    if (event.reason === "new") return;
    restore(ctx, event.reason !== "reload");
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Armed by a bare `/goal`: the first real message becomes the objective, so the
    // goal only exists once the user has actually described it.
    const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (armed && prompt && !prompt.startsWith("/")) {
      armed = false;
      objective = prompt;
      status = "running";
      round = 1;
      autonomous = 0;
      completed = false;
      remember();
      publish(ctx);
    }
    if (!objective || status !== "running") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions()}` };
  });

  pi.on("agent_start", () => {
    completed = false;
    // Another attempt (a retry of the failed request, or the queued next round) is
    // under way, so the previous turn's failure is no longer the last word.
    failed = false;
  });

  // Strip the completion marker from the rendered answer, and remember that the
  // model declared the goal done.
  pi.on("message_end", (event: MessageEndEvent) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    let changed = false;
    const content = message.content.map((block) => {
      const typed = block as { type?: string; text?: string };
      if (typed.type === "text" && typeof typed.text === "string" && typed.text.includes(COMPLETE_MARKER)) {
        changed = true;
        completed = true;
        return { ...(block as object), text: typed.text.split(COMPLETE_MARKER).join("").replace(/\n{3,}/g, "\n\n").trimEnd() };
      }
      return block;
    });
    if (!changed) return;
    return { message: { ...(event.message as object), content } as typeof event.message };
  });

  pi.on("agent_end", (event: AgentEndEvent, ctx) => {
    if (!objective || status !== "running") return;
    if (completed) {
      status = "complete";
      completed = false;
      remember();
      publish(ctx);
      ctx.ui.notify(T("目标已完成。", "Goal complete."), "info");
      return;
    }
    // A turn that was stopped by the user must not be continued: re-queueing here
    // would make 停止 start the goal again.
    const stopReason = lastAssistantStopReason(event);
    if (stopReason === "aborted") {
      status = "paused";
      failed = false;
      remember();
      publish(ctx);
      ctx.ui.notify(T("目标已停止，点击继续可恢复。", "Goal stopped. Resume it from the panel."), "info");
      return;
    }
    // A failed request is not continued here: the SDK may be about to retry it, and
    // a queued round would run on top of a request that just failed. `failed` carries
    // the verdict to `agent_settled`, which is where it becomes terminal.
    if (stopReason === "error") {
      failed = true;
      return;
    }
    // The cap is checked before the round is counted: the turn that would have been
    // queued past it is not part of the stretch, so the panel's round is the last one
    // actually run rather than one ahead of it.
    if (autonomous >= ROUND_CAP) {
      status = "paused";
      remember();
      publish(ctx);
      ctx.ui.notify(
        T(
          `已连续执行 ${ROUND_CAP} 轮，目标已暂停。点击继续可接着跑。`,
          `Ran ${ROUND_CAP} rounds unattended; goal paused. Resume it to keep going.`,
        ),
        "warning",
      );
      return;
    }
    round += 1;
    autonomous += 1;
    remember();
    publish(ctx);
    // `deliverAs: "followUp"` is not optional: `agent_end` is emitted from inside the
    // run (the SDK emits it before it retries, compacts or continues), so the session
    // still reports `isStreaming` and a bare `sendUserMessage` throws 「Agent is
    // already processing」 — which is how this loop silently stopped after one round.
    // A follow-up is drained by the same run's post-run pass, so the goal carries on
    // inside the one run and `agent_settled` still lands once, at its real end.
    pi.sendUserMessage(continuePrompt(), { deliverAs: "followUp" });
  });

  /**
   * A run that settled on a failed request pauses the goal.
   *
   * The verdict waits for `agent_settled` because the SDK retries a transient failure
   * inside the same run: `agent_end` fires first, and `agent_start` follows if a retry
   * (or the queued next round) is coming. Settling with `failed` still set means no
   * attempt followed — the last thing the run did was fail — so the goal pauses and
   * says so, instead of spending another round on the same broken request.
   */
  pi.on("agent_settled", (_event, ctx) => {
    if (!objective || status !== "running" || !failed) return;
    failed = false;
    status = "paused";
    remember();
    publish(ctx);
    ctx.ui.notify(T("目标因错误暂停，点击继续可重试本轮。", "Goal paused on an error. Resume it from the panel."), "warning");
  });
}
