import {
  canonicalDagId,
  DAG_TOOLS,
  dagNodeFinished,
  normalizeDagBudget,
  DAG_LIMITS,
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
  tools?: readonly string[];
  scope?: { nodeId: string; runId: string };
  send?: (id: string, message: string) => Promise<void>;
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
    error: node.error?.slice(0, 500),
    model: node.model,
    attempt: node.attempt && node.attempt > 1 ? node.attempt : undefined,
    parentId: node.parentId,
    coordinator: node.coordinator,
    revision: node.revision,
    usage: node.usage,
    report: node.report ? { outcome: node.report.outcome, summary: node.report.summary.slice(0, 240) } : undefined,
    outputLength: node.outputLength,
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
    const contextFrom = task.context_from ?? task.contextFrom;
    const writePaths = task.write_paths ?? task.writePaths;
    if (contextFrom !== undefined && !Array.isArray(contextFrom)) throw new Error("context_from 必须是数组");
    if (writePaths !== undefined && !Array.isArray(writePaths)) throw new Error("write_paths 必须是数组");
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
        ...(profile.skills === true ? { skills: true } : {}),
      },
      dependsOn: dependsOn?.map(String),
      contextFrom: contextFrom?.map(String),
      writePaths: writePaths?.map(String),
      coordinator: task.coordinator === true,
      acceptance: typeof task.acceptance === "string" ? task.acceptance : undefined,
      budget: normalizeDagBudget(task.budget as Parameters<typeof normalizeDagBudget>[0]),
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
    if (signal?.aborted) throw new Error("操作已取消");
    const owner = deps.scope ? store.node(conversationId, deps.scope.nodeId) : undefined;
    if (deps.scope && (!owner || owner.status !== "running" || owner.runId !== deps.scope.runId || signal?.aborted)) throw new Error("这次子任务运行已结束，不能再操作任务图");
    const children = owner ? scheduler.descendants(conversationId, owner.id) : graph();
    const writable = new Set(children.map((node) => node.id));
    const readable = new Set([...writable, ...(owner ? [owner.id] : []), ...(owner?.dependsOn ?? [])]);
    const selected = (): string[] | undefined => {
      const ids = idsOf(input) ?? (owner ? children.map((node) => node.id) : undefined);
      if (owner && ids?.some((id) => !writable.has(id))) throw new Error("只能管理自己创建的子任务");
      return ids;
    };
    if (owner && request.action !== "result" && !owner.coordinator) throw new Error("执行节点只能读取交给自己的上游结果");
    if (owner && request.action === "resume") throw new Error("整图恢复由主 agent 管理；子协调者可以重试自己的节点");
    switch (request.action) {
      case "add": {
        const available = agents();
        const drafts = draftsOf(input, available);
        const refs = new Set(drafts.map((draft, i) => draft.ref?.trim() || `#${i + 1}`));
        if (owner && drafts.some((draft) => draft.dependsOn?.some((id) => !refs.has(id) && !readable.has(canonicalDagId(id))))) throw new Error("子任务只能依赖本批任务、已有子任务或协调者的上游");
        const created = scheduler.add(conversationId, drafts, available, owner?.id, deps.tools);
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
        const wanted = selected();
        const nodes = graph().filter((node) => !wanted || wanted.includes(node.id));
        if (wanted) {
          const missing = wanted.filter((id) => !nodes.some((node) => node.id === id));
          if (missing.length > 0) throw new Error(`没有这些节点：${missing.join(", ")}`);
        }
        const after = typeof input.after_revision === "number" ? input.after_revision : -1;
        return { ok: true, value: { revision: store.get(conversationId)?.revision ?? 0, summary: summary(nodes), nodes: nodes.filter((node) => (node.revision ?? 0) > after).map(brief) } };
      }
      case "result": {
        const id = typeof input.id === "string" ? canonicalDagId(input.id) : "";
        const node = graph().find((item) => item.id === id);
        if (!node) throw new Error(`没有编号为 ${String(input.id)} 的节点；用 dag_status 查看现有节点`);
        if (owner && !readable.has(id)) throw new Error("这个结果不在当前任务的输入或子任务范围内");
        const output = store.output(conversationId, node, typeof input.run_id === "string" ? input.run_id : undefined);
        let offset = Math.max(0, Math.min(output.length, Math.trunc(Number(input.offset) || 0)));
        const limit = Math.max(1, Math.min(12000, Math.trunc(Number(input.limit) || 6000)));
        const query = typeof input.query === "string" ? input.query.slice(0, 500) : "";
        if (query) {
          const found = output.indexOf(query, offset);
          if (found < 0) return { ok: true, value: { ...brief(node), output: "", found: false, totalChars: output.length } };
          offset = Math.max(offset, found - Math.floor(limit / 4));
        }
        const end = Math.min(output.length, offset + limit);
        return {
          ok: true,
          value: { ...brief(node), output: output.slice(offset, end), offset, totalChars: output.length, ...(end < output.length ? { nextOffset: end } : {}), ...(input.include_instruction ? { instruction: node.instruction } : {}) },
        };
      }
      case "wait": {
        const seconds = typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0
          ? Math.min(input.timeoutSeconds, WAIT_MAX_SECONDS)
          : WAIT_DEFAULT_SECONDS;
        const ids = selected();
        if (graph().length === 0) throw new Error("还没有任何节点；先用 dag_add_tasks 添加");
        // An unknown id would make an empty set — "everything finished" — and the wait return at once.
        const missing = (ids ?? []).filter((id) => !graph().some((node) => node.id === id));
        if (missing.length > 0) throw new Error(`没有这些节点：${missing.join(", ")}`);
        const result = await scheduler.wait(conversationId, ids, { timeoutMs: seconds * 1000, signal, ownerId: owner?.id, mode: input.mode === "any" ? "any" : "all" });
        const pending = result.nodes.filter((node) => !dagNodeFinished(node.status));
        return {
          ok: true,
          value: {
            settled: result.settled,
            ...(result.settled ? {} : { note: signal?.aborted ? "等待被中止，节点仍在继续执行" : `等了 ${seconds} 秒仍有 ${pending.length} 个节点未结束；它们仍在继续，可以再 dag_wait` }),
            summary: summary(result.nodes),
            nodes: result.nodes.map((node) => input.include_outputs === true ? withPreview(node) : brief(node)),
          },
        };
      }
      case "cancel": {
        const touched = scheduler.cancel(conversationId, selected());
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
        const id = typeof input.id === "string" ? canonicalDagId(input.id) : "";
        if (!id) throw new Error("需要节点编号 id");
        if (owner && !writable.has(id)) throw new Error("只能重试自己创建的子任务");
        return { ok: true, value: { reset: scheduler.retry(conversationId, id) } };
      }
      case "update": {
        const id = canonicalDagId(String(input.id ?? ""));
        if (owner && !writable.has(id)) throw new Error("只能修改自己创建的子任务");
        const instruction = typeof input.instruction === "string" ? input.instruction.trim() : undefined;
        if (instruction !== undefined && (!instruction || instruction.length > DAG_LIMITS.instructionChars)) throw new Error("任务说明为空或过长");
        return { ok: true, value: brief(scheduler.update(conversationId, id, {
          ...(instruction !== undefined ? { instruction } : {}),
          ...(typeof input.acceptance === "string" ? { acceptance: input.acceptance.slice(0, 8000) } : {}),
          ...(input.budget ? { budget: normalizeDagBudget(input.budget as Parameters<typeof normalizeDagBudget>[0]) } : {}),
        })) };
      }
      case "send": {
        const id = canonicalDagId(String(input.id ?? ""));
        if (owner && !writable.has(id)) throw new Error("只能向自己创建的子任务补充信息");
        const message = typeof input.message === "string" ? input.message.trim() : "";
        if (!message || message.length > 12000) throw new Error("补充信息为空或过长");
        if (!deps.send) throw new Error("当前宿主不支持补充信息");
        await deps.send(id, message);
        return { ok: true, value: { id, delivered: true } };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
