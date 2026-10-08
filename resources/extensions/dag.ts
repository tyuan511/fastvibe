import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The main agent's hands on its DAG of sub-agent tasks.
 *
 * The agent writes the graph itself, as it works: each node is a sub-agent with a profile
 * the agent invents for that node (a name, its own instructions, the tools it may use), a
 * task, and the nodes it depends on. FastVibe then runs the graph on its own — a node starts
 * when everything it depends on has finished, independent nodes run in parallel, a failure
 * skips only what depended on it — and the side pane draws the graph and every node's state.
 *
 * Holds no scheduling code: every call crosses into Main (`src/main/dag-tools.ts`) through
 * `ctx.ui.dag`. DAG sessions load this surface with a restricted active tool set; the host enforces ownership and delegation depth.
 */

type DagResult = { ok: true; value: unknown } | { ok: false; error: string };

type DagHost = {
  dag?(request: { action: string; input?: Record<string, unknown> }, signal?: AbortSignal): Promise<DagResult>;
};

const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);

async function call(ctx: ExtensionContext, action: string, input: Record<string, unknown>, signal?: AbortSignal) {
  const host = ctx.ui as unknown as DagHost;
  if (!host.dag) {
    return {
      content: [{ type: "text" as const, text: T("当前宿主不支持子 Agent 任务编排。", "This host has no sub-agent task graph.") }],
      details: { action, ok: false },
      isError: true,
    };
  }
  const result = await host.dag({ action, input }, signal);
  return result.ok
    ? { content: [{ type: "text" as const, text: JSON.stringify(result.value, null, 2) }], details: { action, ok: true } }
    : { content: [{ type: "text" as const, text: result.error }], details: { action, ok: false }, isError: true };
}

const TOOLS = Type.Array(Type.String(), {
  description:
    "Tools this sub-agent may use: explicitly named connected MCP tools, or read, grep, find, ls (read-only, the default) and edit, write, bash (change files / run commands). Grant the minimum the node needs.",
});

const NODE = Type.Object({
  coordinator: Type.Optional(Type.Boolean({ description: "A read-only coordinator may dynamically create and manage children within its own scope (at most 3 levels). Use only for a module that needs its own planning context; delegate writes to workers." })),
  acceptance: Type.Optional(Type.String({ description: "Concrete conditions and evidence required for completion. Use an independent downstream reviewer for important changes." })),
  context_from: Type.Optional(Type.Array(Type.String(), { description: "Subset of depends_on whose result summaries are needed. [] means ordering only. Omit for all dependencies. Full outputs are read on demand with dag_result." })),
  write_paths: Type.Optional(Type.Array(Type.String(), { description: "Relative files/directories this writer owns. Overlapping writers are serialized across graphs sharing a workspace. Omitted writers claim the whole workspace. This is a scheduling contract, not a filesystem sandbox." })),
  budget: Type.Optional(Type.Object({
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000000 })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 14400 })),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }, { description: "Execution limits. Defaults: 80 turns, 300000 cumulative tokens, 3600 seconds, 5 attempts. Cancellation never undoes effects already performed." })),
  ref: Type.Optional(
    Type.String({ description: "A short local name for this task, so other tasks in the same call can list it in depends_on." }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "Name of a sub-agent already configured in Settings (the same names as the subagent tool). When it fits the task, set this and omit profile: the node runs as that agent, with its instructions, tools, model and reasoning effort. Omit it only when no configured agent fits, and write a profile instead.",
    }),
  ),
  title: Type.String({ description: "Short title shown in the graph, e.g. \"Audit auth middleware\"." }),
  instruction: Type.String({
    description:
      "The task itself, written as a self-contained brief: the sub-agent sees only this text (plus the results of the tasks it depends on), not this conversation. Say what to do and what to report back.",
  }),
  profile: Type.Optional(Type.Object({
    name: Type.String({ description: "Role name, e.g. security-auditor." }),
    description: Type.Optional(Type.String({ description: "One line on what this role is for." })),
    instructions: Type.String({
      description: "The sub-agent's system instructions: who it is, how it works, what it must and must not do, how to report. Written for this task.",
    }),
    tools: Type.Optional(TOOLS),
    skills: Type.Optional(Type.Boolean({ description: "Load the installed skill catalog for this task, only when it needs skills." })),
  })),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tasks that must finish first: a ref from this same call, or the id of an existing task (T-0001). Their results are handed to this task.",
    }),
  ),
});

const IDS = Type.Optional(Type.Array(Type.String(), { description: "Task ids such as T-0001. Omit for all tasks." }));

export default function dagExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dag_add_tasks",
    label: T("添加子任务", "Add sub-agent tasks"),
    description: [
      "Create sub-agent tasks and run them as a dependency graph (DAG). Each task is its own sub-agent with a profile you write for it; a task starts as soon as every task it depends on has completed, tasks with no unmet dependencies run in parallel, and a failed task makes only its downstream tasks skip.",
      "Tasks get ids T-0001, T-0002 … and run on their own after this call returns — you do not drive them; at most 5 run at once. You may call this again later to grow the graph; new tasks can depend on existing ones.",
      "Configured roles use their configured model; ad-hoc profiles follow your model. Only nodes marked coordinator may create child tasks. At most 5 DAG runs execute across the engine; waiting coordinators release their slot.",
    ].join(" "),
    promptSnippet: "Split work into sub-agent tasks that run as a dependency graph (DAG)",
    promptGuidelines: [
      "Use dag_add_tasks when the work divides into parts that can be done independently or in stages (survey several areas in parallel, then synthesize; implement, then review). Do not use it for a step you can do directly.",
      "Prefer a sub-agent that is already configured: the same roles the subagent tool lists. When one fits the task, set the task's agent to that role's exact name and omit profile — the node then runs as that agent, on the model configured for it. Write a profile only when no configured agent fits.",
      "Tasks that can run at the same time (no depends_on path between them) must be truly independent: neither needs the other's result, and no two of them change the same files. If one needs another's output, or both must edit the same file, chain them with depends_on — they share one working directory.",
      "Write each profile for its task: a focused role with concrete instructions. Default to read-only tools; give edit/write/bash only to a task that must change things.",
      "A task's instruction must be self-contained. State what the task should report back — its final message is what dependent tasks receive.",
      "Keep main-context traffic small: pass explicit context_from, read summaries first, and use dag_result pages only for evidence you need. Use coordinator nodes for modules that need local planning. Workers must report blocked when unable to satisfy acceptance. Repair a failed contract with dag_update before retrying. Never retry external side effects blindly.",
      "After adding tasks you may call dag_wait to block until they finish, then read what you need with dag_result and answer the user. If you end your turn without waiting, you will receive a message when the whole graph has finished — summarise the results then. Do not poll in a tight loop.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(NODE, { description: "The tasks to add (at most 30 per call)." }),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      return call(ctx, "add", input, _signal);
    },
  });

  pi.registerTool({
    name: "dag_status",
    label: T("查看子任务状态", "Sub-agent task status"),
    description:
      "Show the sub-agent tasks and their status: pending, running, completed, failed, skipped (an upstream task did not succeed) or cancelled. Returns ids, titles, dependencies and errors, not outputs — use dag_result for a task's output.",
    promptSnippet: "Check the status of sub-agent tasks",
    parameters: Type.Object({ ids: IDS, after_revision: Type.Optional(Type.Integer({ minimum: 0, description: "Only return nodes changed after this revision. The response always includes the current revision and aggregate counts." })) }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      return call(ctx, "status", input);
    },
  });

  pi.registerTool({
    name: "dag_result",
    label: T("读取子任务结果", "Read a task's result"),
    description: "Read a bounded page of the complete saved output, including earlier attempts. Use nextOffset to continue or query to jump to evidence. Graph previews may be truncated; this tool reads the artifact.",
    promptSnippet: "Read one sub-agent task's full result",
    parameters: Type.Object({
      id: Type.String({ description: "Task id such as T-0001" }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000, description: "Characters per page; default 6000." })),
      query: Type.Optional(Type.String({ description: "Find this exact text at/after offset and return a surrounding page." })),
      run_id: Type.Optional(Type.String({ description: "Read an earlier attempt, e.g. T-0001.2. Omit for the latest." })),
      include_instruction: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      return call(ctx, "result", input);
    },
  });

  pi.registerTool({
    name: "dag_wait",
    label: T("等待子任务", "Wait for sub-agent tasks"),
    description:
      "Block until the given tasks (default: all) have finished, or the timeout passes, then return compact statuses and structured reports. Set include_outputs only when previews are needed. Failures do not make this error: read the statuses. Tasks keep running if the wait times out.",
    promptSnippet: "Wait for sub-agent tasks to finish",
    parameters: Type.Object({
      ids: IDS,
      mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")], { description: "Wait for all selected tasks, or wake when any finishes so you can replan early." })),
      include_outputs: Type.Optional(Type.Boolean({ description: "Include short output previews. Default false: statuses and structured reports only." })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Seconds to wait (default 600, at most 1800)." })),
    }),
    async execute(_id, input, signal, _onUpdate, ctx) {
      return call(ctx, "wait", input, signal);
    },
  });

  pi.registerTool({
    name: "dag_cancel",
    label: T("取消子任务", "Cancel sub-agent tasks"),
    description:
      "Cancel tasks (default: every unfinished task). Running ones are stopped, waiting ones will not start, and tasks that depend on them are skipped.",
    promptSnippet: "Cancel sub-agent tasks",
    parameters: Type.Object({ ids: IDS }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      return call(ctx, "cancel", input);
    },
  });

  pi.registerTool({
    name: "dag_resume",
    label: T("恢复子任务", "Resume sub-agent tasks"),
    description:
      "Resume a graph that was stopped (the user pressed Stop, tasks were cancelled, or the app was closed while tasks were running): cancelled tasks, and the downstream tasks skipped because of them, start again; completed tasks keep their results. Failed tasks are not touched — retry those with dag_retry.",
    promptSnippet: "Resume a stopped sub-agent task graph",
    promptGuidelines: [
      "Prefer mode:any and explicit ids for stages that may need early replanning. Avoid re-waiting already terminal tasks. Coordinators must wait for their children before reporting completion.",
      "The user pressing Stop on this chat cancels the graph. Resume it with dag_resume only when the user asks to continue.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _input, _signal, _onUpdate, ctx) {
      return call(ctx, "resume", {});
    },
  });

  pi.registerTool({
    name: "dag_retry",
    label: T("重试子任务", "Retry a sub-agent task"),
    description:
      "Run a failed or cancelled task again. Downstream tasks that were skipped because of it are reset and run after it succeeds.",
    promptSnippet: "Retry a failed sub-agent task",
    parameters: Type.Object({ id: Type.String({ description: "Task id such as T-0001" }) }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      return call(ctx, "retry", input);
    },
  });
  pi.registerTool({
    name: "dag_update",
    label: T("调整子任务", "Revise sub-agent task"),
    description: "Revise a pending, blocked, failed or cancelled task before it starts/retries. Live or completed tasks are immutable. This does not start it: use dag_retry for a failed/blocked task.",
    parameters: Type.Object({
      id: Type.String(), instruction: Type.Optional(Type.String()), acceptance: Type.Optional(Type.String()),
      budget: Type.Optional(Type.Object({ maxTurns: Type.Optional(Type.Integer()), maxTokens: Type.Optional(Type.Integer()), timeoutSeconds: Type.Optional(Type.Integer()), maxAttempts: Type.Optional(Type.Integer()) })),
    }),
    async execute(_id, input, signal, _onUpdate, ctx) { return call(ctx, "update", input, signal); },
  });
  pi.registerTool({
    name: "dag_send",
    label: T("补充子任务信息", "Send task guidance"),
    description: "Deliver relevant new evidence or a correction to a running task at its next steering boundary. For an ended task, revise its brief and retry instead.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, input, signal, _onUpdate, ctx) { return call(ctx, "send", input, signal); },
  });

}
