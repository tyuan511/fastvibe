import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "../../shared/types.ts";
import type { BotReportRequest, BotSubmitRequest, BotContext } from "../../shared/bot.ts";

export function botRole(conversation: Pick<Conversation, "kind">): "router" | "worker" | undefined {
  return conversation.kind === "bot-router" ? "router" : conversation.kind === "bot-worker" ? "worker" : undefined;
}

/** Conversation-only tool bridge. The old Task/Run vocabulary is intentionally absent. */
export type BotSessionService = {
  contextFor(conversationId: string): BotContext;
  submit(input: BotSubmitRequest): Promise<unknown>;
  createWork: (input: { requestId: string; title: string; text: string; project?: string }) => Promise<unknown>;
  report: (input: BotReportRequest) => Promise<unknown>;
  ask: (input: { conversationId: string; requestId?: string; question: string }) => Promise<unknown>;
  stopConversation: (input: { conversationId: string; callerConversationId?: string }) => Promise<unknown>;
  continueConversation: (input: { conversationId: string }) => Promise<unknown>;
};

const ROUTER_TOOLS = new Set(["bot_read_context", "bot_create_work", "bot_stop_conversation", "bot_continue_conversation"]);
const BLOCKED_WORKER = /^(?:spawn_agent|send_message|followup_task|wait_agent|interrupt_agent|list_agents|subagent|question|goal|handoff|schedule_.*|dag_.*|worktree_.*|fastvibe_config_.*)$/;
export function botToolAllowed(role: "router" | "worker", name: string): boolean { return role === "router" ? ROUTER_TOOLS.has(name) : !BLOCKED_WORKER.test(name) && !ROUTER_TOOLS.has(name); }

export function botSessionExtension(options: { role: "router" | "worker"; conversationId: string; service: BotSessionService; projects: () => Array<{ cwd: string; name: string }>; }): ExtensionFactory {
  return (pi) => {
    let sealed = false;
    const result = (value: unknown, terminate = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) ?? "Recorded." }], details: value, ...(terminate ? { terminate: true } : {}) });
    if (options.role === "router") {
      pi.registerTool({ name: "bot_read_context", label: "Vivi conversations", description: "Read current Vivi conversation metadata and local projects.", parameters: Type.Object({}), execute: async () => result({ context: options.service.contextFor(options.conversationId), projects: options.projects() }) });
      pi.registerTool({ name: "bot_create_work", executionMode: "sequential", label: "Create Vivi work", description: "Create or reuse one durable Worker conversation for a concrete work request.", parameters: Type.Object({ requestId: Type.String(), title: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }), project: Type.Optional(Type.String()) }), execute: async (_id, input) => result(await options.service.createWork!(input)) });
      pi.registerTool({ name: "bot_stop_conversation", label: "Stop Vivi conversation", description: "Stop one known Worker conversation.", parameters: Type.Object({ conversationId: Type.String() }), execute: async (_id, input) => result(await options.service.stopConversation!({ conversationId: input.conversationId, callerConversationId: options.conversationId })) });
      pi.registerTool({ name: "bot_continue_conversation", label: "Continue Vivi conversation", description: "Resume one paused Worker conversation after checking its state.", parameters: Type.Object({ conversationId: Type.String() }), execute: async (_id, input) => result(await options.service.continueConversation!({ conversationId: input.conversationId })) });
    } else {
      pi.registerTool({ name: "bot_report", executionMode: "sequential", label: "Report Vivi result", description: "Record a factual result. Normal text is idle and is never treated as completion.", parameters: Type.Object({ outcome: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("ready"), Type.Literal("blocked"), Type.Literal("failed")])), summary: Type.String({ minLength: 1 }), evidence: Type.Optional(Type.Array(Type.String())), artifacts: Type.Optional(Type.Array(Type.String())) }), execute: async (_id, input) => { if (sealed) throw new Error("This conversation turn is already closed."); sealed = true; return result(await options.service.report!({ conversationId: options.conversationId, summary: input.summary, outcome: input.outcome, evidence: input.evidence, artifacts: input.artifacts }), true); } });
      pi.registerTool({ name: "bot_ask_user", executionMode: "sequential", label: "Ask about Vivi work", description: "Persist a question and end this turn. The answer continues the same conversation.", parameters: Type.Object({ question: Type.String({ minLength: 1 }) }), execute: async (id, input) => { if (sealed) throw new Error("This conversation turn is already closed."); sealed = true; return result(await options.service.ask!({ conversationId: options.conversationId, requestId: id, question: input.question }), true); } });
    }
    const setTools = (): void => pi.setActiveTools(pi.getActiveTools().filter((name) => botToolAllowed(options.role, name)));
    pi.on("session_start", setTools);
    pi.on("before_agent_start", (event) => { sealed = false; setTools(); const directive = options.role === "router" ? "You are Vivi. Keep routing turns short. Answer ordinary questions directly. For concrete work, reuse a known conversationId or call bot_create_work. Stop or continue existing conversations through their tools. Do not invent completion from idle." : "You are a persistent Vivi Worker conversation. Continue from your history. Record a structured bot_report for useful results, or bot_ask_user when blocked; a normal response is not completion."; return { systemPrompt: `${event.systemPrompt}\n\n${directive}` }; });
    pi.on("context", (event) => { setTools(); if (options.role !== "router") return undefined; const context = options.service.contextFor(options.conversationId); const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== "vivi-live-context"); messages.push({ role: "custom", customType: "vivi-live-context", display: false, timestamp: 0, content: `Current Vivi conversation state:\n${JSON.stringify(context).slice(0, 12000)}` }); return { messages }; });
    pi.on("tool_call", (event) => sealed || !botToolAllowed(options.role, event.toolName) ? { block: true, reason: sealed ? "This conversation turn is already closed." : "This tool is outside the Vivi role." } : undefined);
  };
}
