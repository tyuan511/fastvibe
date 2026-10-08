import {
  canonicalDagId,
  DAG_TOOLS,
  dagNodeFinished,
  type DagConfiguredAgent,
  type DagNode,
  type DagNodeDraft,
} from "../shared/dag.ts";
import { DAG_TOOL_ACTIONS, isDagToolAction, type DagHostRequest, type DagHostResult } from "../shared/dag-tools.ts";
import type { DagStore } from "./engine/dag-store.ts";
import type { DagScheduler } from "./pi/dag-scheduler.ts";

/**
 * The host side of the `dag_*` tools: the main agent's hands on its graph.
 *
 * It calls the scheduler and store the side pane's graph is drawn from, so a node the agent
 * adds appears in the pane the moment it exists, and a node it cancels stops the same run a
 * click on 停止 would. Never throws: an error is data for the agent to read and correct.
 */
export type DagToolDeps = {
  store: DagStore;
  scheduler: DagScheduler;
  /** 设置里已配置的子 Agent。动态编排按名字复用它们；缺省为空，每个节点都现写角色。 */
  agents?: () => readonly DagConfiguredAgent[];
};

/** `wait` 缺省与上限（秒）。上限是为了不让一次工具调用无限期占住主 agent 的这一轮。 */
const WAIT_DEFAULT_SECONDS = 600;
const WAIT_MAX_SECONDS = 1800;
/** 回给主 agent 的每个节点产出最多多少字；全文用 `result` 取。 */
const OUTPUT_PREVIEW = 1500;

function brief(node: DagNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    profile: node.profile.name,
    dependsOn: node.dependsOn.length > 0 ? node.dependsOn : undefined,
    blockedBy: node.blockedBy,
    error: node.error,
    model: node.model,
    attempt: node.attempt && node.attempt > 1 ? node.attempt : undefined,
  };
}

function withPreview(node: DagNode): Record<string, unknown> {
  const output = node.output ?? "";
  return {
    ...brief(node),
    ...(output
      ? { output: output.length > OUTPUT_PREVIEW ? `${output.slice(0, OUTPUT_PREVIEW)}…（用 dag_result 取全文）` : output }
      : {}),
  };
}

/** 告诉主 agent 现在能复用哪些角色，每个带上它的模型，好让它按场景选而不是现写。 */
function roster(agents: readonly DagConfiguredAgent[]): string {
  if (agents.length === 0) return "当前没有已配置的子 Agent，每个任务都要写 profile。";
  const list = agents
    .map((agent) => `${agent.name}（${agent.model ? `模型 ${agent.model}` : "模型跟随主 Agent"}）${agent.description ? `：${agent.description}` : ""}`)
    .join("；");
  return `可复用的子 Agent：${list}。任务对得上就设 agent 为其名字并省略 profile。`;
}

function summary(nodes: readonly DagNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  return counts;
}

function idsOf(input: Record<string, unknown>): string[] | undefined {
  const raw = input.ids;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("ids 必须是编号数组，例如 [\"T-0001\"]");
  return raw.map((item) => canonicalDagId(String(item)));
}

function draftsOf(input: Record<string, unknown>, agents: readonly DagConfiguredAgent[]): DagNodeDraft[] {
  const raw = input.tasks;
  if (!Array.isArray(raw)) throw new Error("tasks 必须是数组");
  return raw.map((item, index): DagNodeDraft => {
    const task = (item ?? {}) as Record<string, unknown>;
    const profile = (task.profile ?? {}) as Record<string, unknown>;
    const toolList = profile.tools;
    if (toolList !== undefined && !Array.isArray(toolList)) throw new Error(`第 ${index + 1} 个任务：profile.tools 必须是数组，可用：${DAG_TOOLS.join(", ")}`);
    const dependsOn = task.depends_on ?? task.dependsOn;
    if (dependsOn !== undefined && !Array.isArray(dependsOn)) throw new Error(`第 ${index + 1} 个任务：depends_on 必须是数组`);
    const agent = typeof task.agent === "string" ? task.agent.trim() : "";
    // 名字对不上就说出来，而不是悄悄现写一个角色：主 agent 以为自己复用了某个角色，
    // 实际跑的却是它随手写的 profile。
    if (agent && !agents.some((item) => item.name.trim().toLowerCase() === agent.toLowerCase())) {
      const names = agents.map((item) => item.name).join("、") || "（没有已配置的子 Agent）";
      throw new Error(`第 ${index + 1} 个任务：没有名为「${agent}」的已配置子 Agent。可用：${names}`);
    }
    return {
      ref: typeof task.ref === "string" ? task.ref : undefined,
      title: String(task.title ?? ""),
      instruction: String(task.instruction ?? ""),
      ...(agent ? { agent } : {}),
      profile: {
        name: String(profile.name ?? ""),
        description: typeof profile.description === "string" ? profile.description : undefined,
        instructions: String(profile.instructions ?? ""),
        tools: toolList?.map(String),
      },
      dependsOn: dependsOn?.map(String),
    };
  });
}

export async function runDagTool(
  deps: DagToolDeps,
  request: DagHostRequest,
  conversationId: string,
  signal?: AbortSignal,
): Promise<DagHostResult> {
  if (!isDagToolAction(request.action)) {
    return { ok: false, error: `未知动作：${request.action}。可用：${DAG_TOOL_ACTIONS.join(", ")}` };
  }
  const { store, scheduler } = deps;
  const input = request.input ?? {};
  const graph = (): readonly DagNode[] => store.get(conversationId)?.nodes ?? [];
  const agents = (): readonly DagConfiguredAgent[] => deps.agents?.() ?? [];
  try {
    switch (request.action) {
      case "add": {
        const available = agents();
        const created = scheduler.add(conversationId, draftsOf(input, available), available);
        return {
          ok: true,
          value: {
            added: created.map(brief),
            agents: roster(available),
            note: "节点已开始按依赖自主执行。用 dag_wait 等它们结束，或 dag_status 查看进度。",
          },
        };
      }
      case "status": {
        const wanted = idsOf(input);
        const nodes = graph().filter((node) => !wanted || wanted.includes(node.id));
        if (wanted) {
          const missing = wanted.filter((id) => !nodes.some((node) => node.id === id));
          if (missing.length > 0) throw new Error(`没有这些节点：${missing.join(", ")}`);
        }
        return { ok: true, value: { summary: summary(nodes), nodes: nodes.map(brief) } };
      }
      case "result": {
        const id = typeof input.id === "string" ? canonicalDagId(input.id) : "";
        const node = graph().find((item) => item.id === id);
        if (!node) throw new Error(`没有编号为 ${String(input.id)} 的节点；用 dag_status 查看现有节点`);
        return {
          ok: true,
          value: { ...brief(node), instruction: node.instruction, output: node.output ?? "", ...(node.error ? { error: node.error } : {}) },
        };
      }
      case "wait": {
        const seconds = typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0
          ? Math.min(input.timeoutSeconds, WAIT_MAX_SECONDS)
          : WAIT_DEFAULT_SECONDS;
        const ids = idsOf(input);
        if (graph().length === 0) throw new Error("还没有任何节点；先用 dag_add_tasks 添加");
        // An unknown id would make an empty set — "everything finished" — and the wait return at once.
        const missing = (ids ?? []).filter((id) => !graph().some((node) => node.id === id));
        if (missing.length > 0) throw new Error(`没有这些节点：${missing.join(", ")}`);
        const result = await scheduler.wait(conversationId, ids, { timeoutMs: seconds * 1000, signal });
        const pending = result.nodes.filter((node) => !dagNodeFinished(node.status));
        return {
          ok: true,
          value: {
            settled: result.settled,
            ...(result.settled ? {} : { note: signal?.aborted ? "等待被中止，节点仍在继续执行" : `等了 ${seconds} 秒仍有 ${pending.length} 个节点未结束；它们仍在继续，可以再 dag_wait` }),
            summary: summary(result.nodes),
            nodes: result.nodes.map(withPreview),
          },
        };
      }
      case "cancel": {
        const touched = scheduler.cancel(conversationId, idsOf(input));
        return { ok: true, value: { cancelled: touched, note: touched.length === 0 ? "没有需要取消的节点" : "依赖它们的节点会被跳过" } };
      }
      case "resume": {
        const reset = scheduler.resume(conversationId);
        return {
          ok: true,
          value: {
            resumed: reset,
            note: reset.length === 0 ? "没有被取消的节点需要恢复（失败的节点用 dag_retry）" : "已取消的节点和因它们被跳过的下游已重新开始，已完成的节点保持不变",
          },
        };
      }
      case "retry": {
        const id = typeof input.id === "string" ? input.id : "";
        if (!id) throw new Error("需要节点编号 id");
        return { ok: true, value: { reset: scheduler.retry(conversationId, id) } };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
