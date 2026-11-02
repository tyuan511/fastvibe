/** Codex-style collaboration tools: persistent threads plus an explicit mailbox. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents";

type Host = {
  conversationId?: string;
  spawnAgent?: (request: { parentId?: string; taskName?: string; agent: string; task: string; systemPrompt: string; tools?: string[]; model?: string; fallbackModel?: string; thinkingLevel?: string; forkTurns?: "none" | "all"; cwd: string; signal?: AbortSignal }) => Promise<unknown>;
  sendAgentMessage?: (request: { threadId: string; message: string; senderId: string }) => Promise<unknown>;
  followupAgent?: (request: { threadId: string; message: string; senderId: string; task?: string }) => Promise<unknown>;
  forkTurns?: "none" | "all";
  waitAgents?: (request: { threadIds?: string[]; timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown[]>;
  interruptAgent?: (threadId: string) => Promise<void>;
  listAgentThreads?: () => Promise<unknown[]>;
};

const scope = StringEnum(["user", "project", "both"] as const, { default: "user" });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: {}, isError: true });
const host = (ctx: { ui: unknown }): Host => ctx.ui as Host;
const sender = (ctx: { ui: unknown }): string => host(ctx).conversationId ?? "root";
const roster = (agents: AgentConfig[]): string => agents.map((a) => `${a.name} — ${a.description}`).join("; ") || "none installed";
const role = (agents: AgentConfig[], name: string): AgentConfig | undefined => agents.find((a) => a.name.toLowerCase() === name.toLowerCase());

const TEAM_GUIDANCE = [
  "You are the root (main) agent: own the user's goal, coordinate the team, integrate results, and make the final decision. Delegation supports your work; it does not replace your responsibility to inspect and verify the result.",
  "Delegate independent, useful work proactively when it can save time or improve quality. Keep dependent work in your own turn until its prerequisite is known, or delegate it with a precise dependency and acceptance condition.",
  "Use the explorer role for a focused factual investigation or codebase question whose result can be reported without editing. Use the worker role for implementation work, and always state the exact files or directories that worker owns, the desired outcome, and how to verify it.",
  "All agents share the same filesystem and project checkout. Coordinate ownership before parallel edits, inspect the current state before changing it, and never revert, reset, or overwrite another agent's work just to resolve a conflict. Integrate changes deliberately and report partial effects.",
  "The roster is injected separately before each request with thread IDs and task names. After an interruption, reload, compaction, or continuation, call list_agents before spawning anything so you reuse existing threads and do not create duplicates.",
  "send_message only adds mailbox context; it does not start or resume a turn. Use followup_task when an idle or interrupted agent must actually begin or resume work. A follow-up is a new turn informed by the thread's latest state, not a promise of exact original execution continuation.",
  "A user Stop is not a request to resume through notifications. Resume only after the user asks to continue and the same task is still relevant: inspect the latest thread state, use followup_task on the existing thread when needed, and recheck the filesystem for partial effects before proceeding.",
  "Completed or failed child turns automatically deliver a FINAL_ANSWER message containing the thread sender, turn, and status. Treat it as a result to evaluate. Ordinary interrupted turns do not send a notification; inspect them with list_agents or wait_agent when the user asks or the task requires it.",
  "Use wait_agent for a meaningful wait, including several minutes, and let it return terminal results. Do not poll list_agents in a tight loop. It can be cancelled when the parent run is cancelled.",
  "Child agents do not recursively become coordinators by default and do not inherit the full parent tool set; assign work that fits the selected role and the tools available to that child.",
].join("\n");

const TOOL_GUIDELINES = {
  spawn: [
    "Use spawn_agent for independent work that is useful enough to justify coordination overhead.",
    "Choose explorer for focused facts and worker for edits. For worker, include exact owned files or directories, acceptance criteria, and a narrow verification command in message.",
    "Before spawning after interruption, reload, compaction, or continuation, use list_agents and reuse an existing thread when it matches the task.",
    "The child shares the filesystem; do not assign overlapping write ownership without coordinating the order.",
  ],
  send: [
    "Use send_message to provide context, evidence, or a correction to an existing thread.",
    "send_message does not start work; use followup_task when the recipient must act or resume.",
  ],
  followup: [
    "Use followup_task to start or resume an idle or interrupted existing thread, after inspecting its latest state and any partial filesystem effects.",
    "Describe the next concrete task and acceptance criteria. This is a new turn, not exact continuation of the interrupted execution.",
  ],
  list: [
    "Use list_agents after interruption, reload, compaction, or continuation before spawning, and whenever you need the latest thread state.",
    "Use it to avoid duplicate threads; do not use it as a tight polling loop while waiting.",
  ],
  wait: [
    "Use wait_agent for a meaningful wait on selected threads, including waits of several minutes; a selected result update may wake the wait while other selected threads continue running.",
    "targets remains compatible: pass selected thread IDs when you need a subset, or omit it for the current team. Evaluate returned states and actual results, including the automatic FINAL_ANSWER message, and verify important work yourself afterward.",
  ],
} as const;

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    let agents: AgentConfig[] = [];
    try { agents = discoverAgents(ctx.cwd, "user").agents; } catch { /* optional role discovery */ }
    return { systemPrompt: `${event.systemPrompt}\n\nAvailable Agent Team roles for this project: ${roster(agents)}.` };
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn agent",
    description: "Create a persistent agent thread for independent work and return immediately. Choose explorer for focused factual investigation or worker for edits with explicit file ownership; the child shares the current filesystem.",
    promptSnippet: "Delegate independent work to a persistent explorer or worker thread",
    promptGuidelines: [TEAM_GUIDANCE, ...TOOL_GUIDELINES.spawn],
    parameters: Type.Object({
      message: Type.String({ description: "Initial task for the new agent" }),
      task_name: Type.String({ description: "Lowercase task name for the new agent" }),
      agent_type: Type.Optional(Type.String({ description: "Optional Codex role override" })),
      model: Type.Optional(Type.String()),
      model_reasoning_effort: Type.Optional(Type.String()),
      fork_turns: Type.Optional(StringEnum(["none", "all"] as const)),
      parent: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      agentScope: Type.Optional(scope),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const h = host(ctx);
      if (!h.spawnAgent) return fail("当前宿主不支持 Agent Team。");
      if (signal?.aborted) return fail("创建 Agent 已取消。");
      const found = discoverAgents(ctx.cwd, params.agentScope ?? "user").agents;
      const selected = role(found, params.agent_type ?? "worker");
      if (!selected) return fail(`找不到 Agent 角色「${params.agent_type ?? "worker"}」。可用角色：${roster(found)}`);
      const thread = await h.spawnAgent({ parentId: params.parent, taskName: params.task_name, agent: selected.name, task: params.message, systemPrompt: selected.systemPrompt, tools: selected.tools, model: params.model ?? selected.model, fallbackModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinkingLevel: params.model_reasoning_effort ?? selected.thinkingLevel, forkTurns: params.fork_turns === "none" ? "none" : "all", cwd: params.cwd ?? ctx.cwd, signal });
      return { content: [{ type: "text", text: `已创建 Agent thread：${JSON.stringify(thread)}` }], details: { thread, forkTurns: params.fork_turns === "none" ? "none" : "all" } };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send message",
    description: "Send context or a correction to an existing agent mailbox without starting or resuming a turn. Use followup_task when the agent must act.",
    promptGuidelines: [...TOOL_GUIDELINES.send],
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
    description: "Start or resume an idle or interrupted agent thread with a concrete follow-up task; this creates a new turn using the thread's latest state.",
    promptGuidelines: [...TOOL_GUIDELINES.followup],
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
    description: "Wait for a meaningful update from selected agent threads, including a result update that may wake the wait before other selected threads finish. Omit targets to use the current team; returned states include actual results delivered through automatic FINAL_ANSWER messages, and cancellation aborts the wait.",
    promptGuidelines: [...TOOL_GUIDELINES.wait],
    parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())), timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 1800000 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const h = host(ctx); if (!h.waitAgents) return fail("当前宿主不支持 Agent wait。");
      const result = await h.waitAgents({ threadIds: params.targets, timeoutMs: params.timeout_ms, signal: _signal });
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
    description: "List the current Agent Team tree and latest thread states so you can reuse existing work instead of spawning duplicates.",
    promptGuidelines: [...TOOL_GUIDELINES.list],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const h = host(ctx); if (!h.listAgentThreads) return fail("当前宿主不支持 Agent list。");
      const result = await h.listAgentThreads();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { threads: result } };
    },
  });
}
