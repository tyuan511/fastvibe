import type { AgentEndEvent, ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

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
 * (a final `GOAL_COMPLETE` marker, stripped before rendering) the loop sends a
 * continuation prompt; the badge/panel reads the `goal` status payload.
 */
const STATUS_KEY = "goal";
/** Armed-but-not-started state: shows the composer badge, not the objective panel. */
const ARMED_STATUS_KEY = "goal-armed";
const COMPLETE_MARKER = "GOAL_COMPLETE";
const MAX_ROUNDS = 40;
const OFF = new Set(["clear", "off", "none", "reset"]);

type GoalState = "running" | "paused" | "complete";

export default function goalMode(pi: ExtensionAPI): void {
  let objective: string | null = null;
  /** `/goal` was picked without an objective; the next user message becomes it. */
  let armed = false;
  let status: GoalState = "running";
  let round = 0;
  let completed = false;

  const publish = (ctx: ExtensionContext): void => {
    if (objective) {
      ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ objective, status, round, max: MAX_ROUNDS }));
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    ctx.ui.setStatus(ARMED_STATUS_KEY, armed ? "armed" : undefined);
  };

  const instructions = (): string => {
    return [
      "## 长期目标",
      `最终目标：${objective}`,
      `当前是第 ${round + 1} 轮。请先对照最终目标评估当前进展，列出本轮需要完成的任务，然后完成它们。`,
      `如果目标已完全达成，请在最后一条消息的最后一行单独输出 ${COMPLETE_MARKER}。`,
    ].join("\n");
  };

  const continuePrompt = (): string =>
    "继续执行目标。对照最终目标检查当前进展，列出并完成下一批任务；若目标已完全达成，请在最后一行输出 GOAL_COMPLETE。";

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
        round = 0;
        completed = false;
        publish(ctx);
        return;
      }
      if (command === "pause") {
        if (!objective) {
          ctx.ui.notify("尚未设置目标。", "warning");
          return;
        }
        status = "paused";
        publish(ctx);
        ctx.ui.notify("目标已暂停。", "info");
        return;
      }
      if (command === "resume") {
        if (!objective) {
          ctx.ui.notify("尚未设置目标。", "warning");
          return;
        }
        if (status === "paused") {
          status = "running";
          publish(ctx);
          ctx.ui.notify("目标已继续。", "info");
          pi.sendUserMessage(continuePrompt());
        }
        return;
      }
      objective = text;
      armed = false;
      status = "running";
      round = 0;
      completed = false;
      publish(ctx);
      pi.sendUserMessage(`开始执行目标：${text}`);
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Armed by a bare `/goal`: the first real message becomes the objective, so the
    // goal only exists once the user has actually described it.
    const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (armed && prompt && !prompt.startsWith("/")) {
      armed = false;
      objective = prompt;
      status = "running";
      round = 0;
      completed = false;
      publish(ctx);
    }
    if (!objective || status !== "running") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions()}` };
  });

  pi.on("agent_start", () => {
    completed = false;
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
      publish(ctx);
      ctx.ui.notify("目标已完成。", "info");
      return;
    }
    round += 1;
    if (round >= MAX_ROUNDS) {
      status = "paused";
      publish(ctx);
      ctx.ui.notify(`已达到最大轮次 ${MAX_ROUNDS}，目标已暂停。`, "warning");
      return;
    }
    publish(ctx);
    pi.sendUserMessage(continuePrompt());
  });
}
