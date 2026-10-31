/** Codex-style collaboration tools: persistent threads plus an explicit mailbox. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents";

type Host = {
  conversationId?: string;
  spawnAgent?: (request: { parentId?: string; agent: string; task: string; systemPrompt: string; tools?: string[]; model?: string; fallbackModel?: string; thinkingLevel?: string; cwd: string }) => Promise<unknown>;
  sendAgentMessage?: (request: { threadId: string; message: string; senderId: string }) => Promise<unknown>;
  followupAgent?: (request: { threadId: string; message: string; senderId: string; task?: string }) => Promise<unknown>;
  waitAgents?: (request: { threadIds?: string[]; timeoutMs?: number }) => Promise<unknown[]>;
  interruptAgent?: (threadId: string) => Promise<void>;
  listAgentThreads?: () => Promise<unknown[]>;
};

const scope = StringEnum(["user", "project", "both"] as const, { default: "user" });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: {}, isError: true });
const host = (ctx: { ui: unknown }): Host => ctx.ui as Host;
const sender = (ctx: { ui: unknown }): string => host(ctx).conversationId ?? "root";
const roster = (agents: AgentConfig[]): string => agents.map((a) => `${a.name} — ${a.description}`).join("; ") || "none installed";
const role = (agents: AgentConfig[], name: string): AgentConfig | undefined => agents.find((a) => a.name.toLowerCase() === name.toLowerCase());

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    let agents: AgentConfig[] = [];
    try { agents = discoverAgents(process.cwd(), "user").agents; } catch { /* optional role discovery */ }
    return { systemPrompt: `${event.systemPrompt}\n\nAvailable Agent Team roles: ${roster(agents)}. Use spawn_agent, send_message, followup_task, wait_agent, interrupt_agent and list_agents.` };
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn agent",
    description: "Create a persistent Codex-style agent thread and return immediately.",
    promptSnippet: "Create and coordinate persistent agent threads",
    parameters: Type.Object({
      message: Type.String({ description: "The first task" }),
      agent: Type.Optional(Type.String({ description: "Configured role name" })),
      model: Type.Optional(Type.String()),
      model_reasoning_effort: Type.Optional(Type.String()),
      fork_turns: Type.Optional(StringEnum(["none", "recent", "all"] as const)),
      parent: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      agentScope: Type.Optional(scope),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const h = host(ctx);
      if (!h.spawnAgent) return fail("当前宿主不支持 Agent Team。");
      if (signal?.aborted) return fail("创建 Agent 已取消。");
      const found = discoverAgents(ctx.cwd, params.agentScope ?? "user").agents;
      const selected = role(found, params.agent ?? "worker");
      if (!selected) return fail(`找不到 Agent 角色「${params.agent ?? "worker"}」。可用角色：${roster(found)}`);
      const thread = await h.spawnAgent({ parentId: params.parent, agent: selected.name, task: params.message, systemPrompt: selected.systemPrompt, tools: selected.tools, model: params.model ?? selected.model, fallbackModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinkingLevel: params.model_reasoning_effort ?? selected.thinkingLevel, cwd: params.cwd ?? ctx.cwd });
      return { content: [{ type: "text", text: `已创建 Agent thread：${JSON.stringify(thread)}` }], details: { thread, forkTurns: params.fork_turns ?? "none" } };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send message",
    description: "Send a mailbox message without starting a new turn.",
    parameters: Type.Object({ target: Type.String(), message: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const h = host(ctx); if (!h.sendAgentMessage) return fail("当前宿主不支持 Agent message。");
      const result = await h.sendAgentMessage({ threadId: params.target, message: params.message, senderId: sender(ctx) });
      return { content: [{ type: "text", text: `消息已发送给 ${params.target}。` }], details: { result } };
    },
  });

  pi.registerTool({
    name: "followup_task",
    label: "Follow up agent",
    description: "Send a new task and trigger or resume the target thread.",
    parameters: Type.Object({ target: Type.String(), message: Type.String(), task: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const h = host(ctx); if (!h.followupAgent) return fail("当前宿主不支持 Agent follow-up。");
      const result = await h.followupAgent({ threadId: params.target, message: params.message, task: params.task, senderId: sender(ctx) });
      return { content: [{ type: "text", text: `已让 ${params.target} 开始下一轮。` }], details: { result } };
    },
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Wait agent",
    description: "Wait for selected agent threads to finish. Omit targets to wait for the current team.",
    parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())), timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 1800000 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const h = host(ctx); if (!h.waitAgents) return fail("当前宿主不支持 Agent wait。");
      const result = await h.waitAgents({ threadIds: params.targets, timeoutMs: params.timeout_ms });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { threads: result } };
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt agent",
    description: "Interrupt one active thread while preserving its history.",
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const h = host(ctx); if (!h.interruptAgent) return fail("当前宿主不支持 Agent interrupt。");
      await h.interruptAgent(params.target);
      return { content: [{ type: "text", text: `已中断 ${params.target}。` }], details: { target: params.target } };
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    description: "List the Agent Team tree and statuses.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const h = host(ctx); if (!h.listAgentThreads) return fail("当前宿主不支持 Agent list。");
      const result = await h.listAgentThreads();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { threads: result } };
    },
  });
}
