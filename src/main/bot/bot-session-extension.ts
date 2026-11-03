import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "../../shared/types.ts";
import type { BotProgressRequest, BotReportRequest, BotSubmitRequest, BotContext } from "../../shared/bot.ts";

export function botRole(conversation: Pick<Conversation, "kind">): "router" | "worker" | undefined {
  return conversation.kind === "bot-router" ? "router" : conversation.kind === "bot-worker" ? "worker" : undefined;
}

/** Conversation-only tool bridge. The old Task/Run vocabulary is intentionally absent. */
export type BotSessionService = {
  contextFor(conversationId: string): BotContext;
  submit(input: BotSubmitRequest): Promise<unknown>;
  routeMessage: (input: BotSubmitRequest) => Promise<unknown>;
  reply: (input: { conversationId: string; text: string; requestId?: string; epoch?: number }) => Promise<unknown>;
  progress: (input: BotProgressRequest) => Promise<unknown>;
  createWork: (input: { requestId: string; title: string; text: string }) => Promise<unknown>;
  report: (input: BotReportRequest) => Promise<unknown>;
  ask: (input: { conversationId: string; requestId?: string; epoch?: number; question: string }) => Promise<unknown>;
  stopConversation: (input: { conversationId: string; callerConversationId?: string }) => Promise<unknown>;
  continueConversation: (input: { conversationId: string }) => Promise<unknown>;
};

const ROUTER_TOOLS = new Set(["bot_read_context", "bot_create_work", "bot_send_message", "bot_reply", "bot_stop_conversation", "bot_continue_conversation"]);
const BLOCKED_WORKER = /^(?:spawn_agent|send_message|followup_task|wait_agent|interrupt_agent|list_agents|subagent|question|goal|handoff|schedule_.*|dag_.*|worktree_.*|fastvibe_config_.*)$/;
export function botToolAllowed(role: "router" | "worker", name: string): boolean { return name === "bot_progress" || (role === "router" ? ROUTER_TOOLS.has(name) : !BLOCKED_WORKER.test(name) && !ROUTER_TOOLS.has(name)); }

export function botSessionExtension(options: { role: "router" | "worker"; conversationId: string; service: BotSessionService; projects: () => Array<{ cwd: string; name: string }>; }): ExtensionFactory {
  return (pi) => {
    let sealed = false;
    let receipt: BotContext["input"];
    const ownedInput = () => ({ conversationId: options.conversationId, requestId: receipt?.requestId, epoch: receipt?.epoch });
    const result = (value: unknown, terminate = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) ?? "Recorded." }], details: value, ...(terminate ? { terminate: true } : {}) });
    pi.registerTool({
      name: "bot_progress", executionMode: "sequential", label: "Update Vivi progress",
      description: "Update the current factual phase in one short user-facing sentence. Use planning only while deciding an approach, working for actual execution, and summarizing while assembling existing results. Set milestone only for a useful intermediate accomplishment, with at most three per user request. Never emit heartbeats, guesses, fabricated percentages or ETAs. This tool does not end the turn.",
      parameters: Type.Object({ phase: Type.Union([Type.Literal("understanding"), Type.Literal("planning"), Type.Literal("working"), Type.Literal("summarizing")]), text: Type.String({ minLength: 1, maxLength: 240 }), milestone: Type.Optional(Type.Boolean()) }),
      execute: async (_id, input, signal) => {
        if (sealed || signal?.aborted) throw new Error("This conversation turn is already closed.");
        return result(await options.service.progress({ ...ownedInput(), ...input }));
      },
    });
    if (options.role === "router") {
      pi.registerTool({ name: "bot_read_context", label: "Vivi conversations", description: "Read current Vivi conversation metadata and local projects.", parameters: Type.Object({}), execute: async () => result({ context: options.service.contextFor(options.conversationId), projects: options.projects() }) });
      pi.registerTool({ name: "bot_create_work", executionMode: "sequential", label: "Create Vivi work", description: "Create or reuse one durable Worker conversation in Vivi's fixed private workspace.", parameters: Type.Object({ requestId: Type.String(), title: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) }), execute: async (_id, input) => result(await options.service.createWork!(input)) });
      pi.registerTool({ name: "bot_send_message", executionMode: "sequential", label: "Message Vivi conversation", description: "Send additional requirements to an existing Worker conversation without creating another one. Use a new requestId; resume a paused Worker first.", parameters: Type.Object({ conversationId: Type.String({ minLength: 1 }), requestId: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) }), execute: async (_id, input) => {
        if (options.service.contextFor(input.conversationId).role !== "worker") throw new Error("Only Worker conversations can receive routed messages.");
        await options.service.routeMessage(input);
        return result({ conversationId: input.conversationId, requestId: input.requestId, accepted: true });
      } });
      pi.registerTool({ name: "bot_reply", executionMode: "sequential", label: "Reply to Vivi user", description: "Send a concise, natural user-facing answer and end this Router turn. Acknowledge what you actually arranged, or explain the result and what is still needed. Never claim work is finished without a ready result.", parameters: Type.Object({ text: Type.String({ minLength: 1 }) }), execute: async (_id, input, signal) => { if (sealed || signal?.aborted) throw new Error("This conversation turn is already closed."); const message = await options.service.reply!({ ...ownedInput(), text: input.text }); sealed = true; return result(message, true); } });

      pi.registerTool({ name: "bot_stop_conversation", label: "Stop Vivi conversation", description: "Stop one known Worker conversation.", parameters: Type.Object({ conversationId: Type.String() }), execute: async (_id, input) => result(await options.service.stopConversation!({ conversationId: input.conversationId, callerConversationId: options.conversationId })) });
      pi.registerTool({ name: "bot_continue_conversation", label: "Continue Vivi conversation", description: "Resume one paused Worker conversation after checking its state.", parameters: Type.Object({ conversationId: Type.String() }), execute: async (_id, input) => result(await options.service.continueConversation!({ conversationId: input.conversationId })) });
    } else {
      pi.registerTool({ name: "bot_report", executionMode: "sequential", label: "Report Vivi result", description: "Record the actual outcome, what was accomplished, verification evidence and artifact paths, then end this turn. Use ready only when the requested work is complete. Explain missing work and how to proceed for blocked/failed outcomes. Plain text without a report never proves completion.", parameters: Type.Object({ outcome: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("ready"), Type.Literal("blocked"), Type.Literal("failed")])), summary: Type.String({ minLength: 1 }), evidence: Type.Optional(Type.Array(Type.String())), artifacts: Type.Optional(Type.Array(Type.String())) }), execute: async (_id, input, signal) => { if (sealed || signal?.aborted) throw new Error("This conversation turn is already closed."); const reported = await options.service.report!({ ...ownedInput(), summary: input.summary, outcome: input.outcome, evidence: input.evidence, artifacts: input.artifacts }); sealed = true; return result(reported, true); } });
      pi.registerTool({ name: "bot_ask_user", executionMode: "sequential", label: "Ask about Vivi work", description: "Persist a necessary question and end this turn. Say what is already done and what answer is needed to proceed. The answer continues the same conversation.", parameters: Type.Object({ question: Type.String({ minLength: 1 }) }), execute: async (_id, input, signal) => { if (sealed || signal?.aborted) throw new Error("This conversation turn is already closed."); const attention = await options.service.ask!({ ...ownedInput(), question: input.question }); sealed = true; return result(attention, true); } });
    }
    const setTools = (): void => pi.setActiveTools(pi.getActiveTools().filter((name) => botToolAllowed(options.role, name)));
    pi.on("session_start", setTools);
    pi.on("before_agent_start", (event) => {
      sealed = false;
      receipt = options.service.contextFor(options.conversationId).input;
      setTools();
      const directive = options.role === "router"
        ? "You are Vivi, a thoughtful assistant who stays with the user's ongoing work. Speak naturally and briefly in the user's preferred language. Use bot_reply for every user-facing answer, including ordinary questions and concise arrangements or updates; it ends this turn. First understand the user's actual intent. For concrete execution create or reuse a Worker, and only then acknowledge what you arranged. For additional instructions reuse the known conversationId with bot_send_message and a fresh requestId; explicitly resume paused work first. Use the live progress, pending questions and results to answer status questions immediately without creating more work. For a result, state what was done, link useful artifacts, mention the evidence, and explain any unfinished part or next decision. Partial or idle results never prove completion. Use bot_progress only when a real phase changes; do not expose raw tools, thinking or internal coordination. Milestones are occasional useful accomplishments, never filler. New user instructions take priority over background updates. Vivi uses its fixed private workspace and accepts no project override. Do not invent timing estimates, percentages, progress or remembered preferences. Keep this conversational, without unnecessary greetings or repeated acknowledgements."
        : "You are a persistent Vivi Worker conversation. Continue from your history and the current input. Use bot_progress for meaningful real phase changes, and milestone:true only after a useful intermediate accomplishment worth telling the user. At most three such messages per user request; never send periodic chatter, simulated thinking or guesses. Keep tool details and reasoning internal. Finish with bot_report containing a factual summary, verification evidence and produced artifact paths. Use ready only when the requested work is complete; for partial/blocked/failed work describe what is preserved and what is needed next. Ask a necessary question with bot_ask_user rather than silently waiting. A normal response alone is not proof of completion.";
      return { systemPrompt: `${event.systemPrompt}\n\n${directive}` };
    });
    pi.on("context", (event) => { setTools(); const context = options.service.contextFor(options.conversationId); const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== "vivi-live-context"); messages.push({ role: "custom", customType: "vivi-live-context", display: false, timestamp: 0, content: `Current Vivi conversation state:\n${JSON.stringify(context).slice(0, 12000)}` }); return { messages }; });
    pi.on("tool_call", (event) => sealed || !botToolAllowed(options.role, event.toolName) ? { block: true, reason: sealed ? "This conversation turn is already closed." : "This tool is outside the Vivi role." } : undefined);
  };
}
