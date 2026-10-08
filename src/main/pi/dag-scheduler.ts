import { canonicalDagId, dagGraphState, dagNodeFinished, dagRunId, resolveDrafts, type DagConfiguredAgent, type DagNode, type DagNodeDraft } from "../../shared/dag.ts";
import type { DagStore } from "../engine/dag-store.ts";

/** 一个节点跑完的结果。`aborted` 是被取消 / 被用户停止，不算失败。 */
export type DagNodeRun = {
  status: "completed" | "failed" | "aborted";
  /** 子 agent 的最后一段话。 */
  output: string;
  error?: string;
  /** 实际用的模型 `provider/id`。 */
  model?: string;
};

/** 调度器需要引擎做的唯一一件事：把一个节点当作一次子 agent 运行跑完。 */
export type DagRunner = (args: {
  conversationId: string;
  node: DagNode;
  /** 任务说明加上上游节点的产出，已经拼好。 */
  prompt: string;
  signal: AbortSignal;
}) => Promise<DagNodeRun>;

/** 每个依赖的产出拼进下游提示词时最多带多少字。 */
const HANDOFF_LIMIT = 6000;
/** 同一张图同时最多跑几个子 agent。固定值，暂不开放设置。 */
export const DAG_CONCURRENCY = 5;

export type DagWaitResult = { settled: boolean; nodes: DagNode[] };

/**
 * 按依赖关系自主地把一张图跑完。
 *
 * 规则只有四条，都写在 `#pump` 里：
 * 1. 一个节点的所有依赖都 `completed` 才会开始；
 * 2. 依赖里有 `failed` / `skipped` / `cancelled` 的，节点被 `skipped`（并记下是谁挡住了它），
 *    这条沿图传下去——不会拿一个没做成的上游的空结果去跑下游；
 * 3. 同一张图同时最多跑 `DAG_CONCURRENCY`（5）个；
 * 4. 每个节点结束（或被取消）都会再泵一次，所以图自己往前走，不需要主 agent 轮询。
 *
 * 状态只写进 `DagStore`（它去抖落盘并通知侧边的图），这里不另存一份。
 */
export class DagScheduler {
  #store: DagStore;
  #run: DagRunner;
  #concurrency: number;
  /** 正在跑的节点的取消开关，键是 `${会话}\u0000${节点}`。 */
  #running = new Map<string, AbortController>();
  /** 我们自己要求停止的节点；它们回来时是 `cancelled`，不管 runner 怎么说。 */
  #cancelling = new Map<string, string>();
  /**
   * 被取消、还没收尾就被要求恢复的节点。停止和恢复之间只隔一次点击，运行中的节点那时还在退出：
   * 它回来时不能落成「已取消」（那样图又停一半），而是直接回到等待。
   */
  #resumeWanted = new Set<string>();
  /** 等待者，连同它在等哪个会话的图：图跑完时有人在等，就不必另外通知主 agent。 */
  #waiters = new Map<() => void, string>();
  /** 已经通知过「跑完了」的图；图再次动起来（追加 / 重试 / 恢复）时清掉，下次跑完再通知。 */
  #settledNotified = new Set<string>();
  #onSettled: ((conversationId: string, nodes: DagNode[]) => void) | undefined;
  /** 自上次通知以来真的跑过节点的图。只为「做了事」的一轮通知，不为一批刚加进来就全被跳过的节点。 */
  #ranSinceSettled = new Set<string>();
  #stopped = false;

  constructor(
    store: DagStore,
    run: DagRunner,
    options?: {
      concurrency?: number;
      /**
       * 一张图里不再有等待中或运行中的节点、且不是被停止的（有成功或失败的结果），而主 agent 此刻
       * 没有在 `dag_wait` 里等它——这时主 agent 不会自己知道结果，需要被告知。每「跑完一次」只调一次。
       */
      onSettled?: (conversationId: string, nodes: DagNode[]) => void;
    },
  ) {
    this.#store = store;
    this.#run = run;
    this.#concurrency = Math.max(1, options?.concurrency ?? DAG_CONCURRENCY);
    this.#onSettled = options?.onSettled;
  }

  /** Enable new work after the engine is ready; interrupted graphs still need explicit resume. */
  start(): void {
    this.#stopped = false;
  }

  /** Stop scheduling before aborting any runner: its completion may otherwise start the next node. */
  stop(reason = "引擎已停止"): void {
    this.#stopped = true;
    this.#resumeWanted.clear();
    for (const graph of this.#store.list()) this.cancel(graph.conversationId, undefined, reason);
  }

  #assertStarted(): void {
    if (this.#stopped) throw new Error("引擎已停止，启动后再恢复任务");
  }

  /** 追加一批节点并立刻开始调度。校验失败整批不加。 */
  add(conversationId: string, drafts: readonly DagNodeDraft[], agents: readonly DagConfiguredAgent[] = []): DagNode[] {
    this.#assertStarted();
    const existing = new Set((this.#store.get(conversationId)?.nodes ?? []).map((node) => node.id));
    const resolved = resolveDrafts(existing, drafts, agents);
    const created = this.#store.append(conversationId, (allocate) => {
      const ids = resolved.map(() => allocate());
      return resolved.map((draft, index) => ({
        id: ids[index],
        title: draft.title,
        instruction: draft.instruction,
        profile: draft.profile,
        dependsOn: [...draft.existingDeps, ...draft.batchDeps.map((dep) => ids[dep])],
        status: "pending" as const,
        // 复用的角色连同它的模型一起记下：重试和恢复重跑的是同一个节点，不能到那时再去
        // 查一次配置——角色可能已经被改掉或删掉。
        ...(draft.agent ? { agent: draft.agent } : {}),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
      }));
    });
    this.#pump(conversationId);
    return created.map((node) => this.#store.node(conversationId, node.id) ?? node);
  }

  /**
   * 取消节点（缺省取消所有没结束的）。等待中的直接取消，运行中的发出停止、回来时记为取消；
   * 依赖它们的节点随后被跳过。返回被影响的节点编号。
   */
  cancel(conversationId: string, ids?: readonly string[], reason = "已取消"): string[] {
    const graph = this.#store.get(conversationId);
    if (!graph) return [];
    const wanted = ids ? new Set(ids.map(canonicalDagId)) : undefined;
    const touched: string[] = [];
    for (const node of graph.nodes) {
      if (wanted && !wanted.has(node.id)) continue;
      if (node.status === "pending") {
        this.#store.patch(conversationId, node.id, { status: "cancelled", error: reason, endedAt: Date.now() });
        touched.push(node.id);
      } else if (node.status === "running") {
        const key = keyOf(conversationId, node.id);
        this.#resumeWanted.delete(key);
        this.#cancelling.set(key, reason);
        this.#running.get(key)?.abort();
        touched.push(node.id);
      }
    }
    this.#pump(conversationId);
    this.#notify();
    return touched;
  }

  /**
   * 恢复被中断的图：所有 `cancelled` 的节点，连同因它们而被跳过的下游，回到等待并继续跑。
   * 已完成的节点原样保留，产出照旧交给下游——恢复接着做，不是重来。失败的不动：失败是结果，要逐个重试。
   * 返回被重置的节点编号。
   */
  resume(conversationId: string): string[] {
    this.#assertStarted();
    const graph = this.#store.get(conversationId);
    if (!graph) throw new Error("这个会话还没有任务图");
    const reset = new Set(graph.nodes.filter((node) => node.status === "cancelled").map((node) => node.id));
    const stillStopping = graph.nodes.filter((node) => node.status === "running" && this.#cancelling.has(keyOf(conversationId, node.id)));
    for (const node of stillStopping) this.#resumeWanted.add(keyOf(conversationId, node.id));
    if (reset.size === 0) return stillStopping.map((node) => node.id);
    for (let grew = true; grew; ) {
      grew = false;
      for (const node of graph.nodes) {
        if (reset.has(node.id) || node.status !== "skipped") continue;
        if (node.dependsOn.some((dep) => reset.has(dep))) {
          reset.add(node.id);
          grew = true;
        }
      }
    }
    for (const id of reset) this.#resetNode(conversationId, id);
    this.#pump(conversationId);
    return [...reset, ...stillStopping.map((node) => node.id)];
  }

  #resetNode(conversationId: string, id: string): void {
    const node = this.#store.node(conversationId, id);
    this.#store.patch(conversationId, id, {
      status: "pending",
      output: undefined,
      error: undefined,
      blockedBy: undefined,
      startedAt: undefined,
      endedAt: undefined,
      runId: undefined,
      // `model` 在运行后记的是这次实际用的模型。复用角色的节点例外：那里记的是角色
      // 自己的模型，清掉的话重跑就退回跟随主 agent。
      ...(node?.agent ? {} : { model: undefined }),
    });
  }

  /** 重试一个失败 / 被取消的节点，连同因它而被跳过的下游。返回被重置的节点编号。 */
  retry(conversationId: string, id: string): string[] {
    this.#assertStarted();
    const graph = this.#store.get(conversationId);
    const target = graph?.nodes.find((node) => node.id === canonicalDagId(id));
    if (!graph || !target) throw new Error(`没有编号为 ${id} 的节点`);
    if (target.status !== "failed" && target.status !== "cancelled") {
      throw new Error(`${target.id} 当前是 ${target.status}，只有失败或已取消的节点能重试`);
    }
    const reset = new Set<string>([target.id]);
    // 沿依赖往下找：因为它（直接或间接）被跳过的节点，一起回到等待。
    for (let grew = true; grew; ) {
      grew = false;
      for (const node of graph.nodes) {
        if (reset.has(node.id) || node.status !== "skipped") continue;
        if (node.dependsOn.some((dep) => reset.has(dep))) {
          reset.add(node.id);
          grew = true;
        }
      }
    }
    for (const nodeId of reset) this.#resetNode(conversationId, nodeId);
    this.#pump(conversationId);
    return [...reset];
  }

  /**
   * 等指定节点（缺省全部）都结束，或超时 / 被中止。`settled` 说的是「是不是都结束了」。
   * 不会因为节点失败而拒绝——失败是结果，由调用方读。
   */
  wait(conversationId: string, ids: readonly string[] | undefined, options: { timeoutMs: number; signal?: AbortSignal }): Promise<DagWaitResult> {
    const wanted = ids ? new Set(ids.map(canonicalDagId)) : undefined;
    const snapshot = (): DagNode[] =>
      (this.#store.get(conversationId)?.nodes ?? []).filter((node) => !wanted || wanted.has(node.id));
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (settled: boolean): void => {
        if (timer) clearTimeout(timer);
        this.#waiters.delete(check);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ settled, nodes: snapshot() });
      };
      const check = (): void => {
        const nodes = snapshot();
        if (nodes.every((node) => dagNodeFinished(node.status))) done(true);
      };
      const onAbort = (): void => done(false);
      this.#waiters.set(check, conversationId);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => done(false), Math.max(0, options.timeoutMs));
      timer.unref?.();
      if (options.signal?.aborted) onAbort();
      else check();
    });
  }

  /** 会话被删：停掉它的所有运行并丢掉图。 */
  dropConversation(conversationId: string): void {
    for (const [key, controller] of this.#running) {
      if (key.startsWith(`${conversationId}\u0000`)) {
        this.#cancelling.set(key, "会话已删除");
        this.#resumeWanted.delete(key);
        controller.abort();
      }
    }
    this.#store.drop(conversationId);
    this.#settledNotified.delete(conversationId);
    this.#ranSinceSettled.delete(conversationId);
    this.#notify();
  }

  #pump(conversationId: string): void {
    if (this.#stopped) {
      this.#notify();
      return;
    }
    // 先把「上游没成功」的传播下去：一个节点被跳过，可能让它的下游也该被跳过。
    for (let changed = true; changed; ) {
      changed = false;
      const graph = this.#store.get(conversationId);
      if (!graph) return;
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      for (const node of graph.nodes) {
        if (node.status !== "pending") continue;
        const blocker = node.dependsOn.map((dep) => byId.get(dep)).find((dep) => dep && ["failed", "skipped", "cancelled"].includes(dep.status));
        if (!blocker) continue;
        this.#store.patch(conversationId, node.id, {
          status: "skipped",
          blockedBy: blocker.id,
          error: `上游 ${blocker.id} 没有成功（${blocker.status}）`,
          endedAt: Date.now(),
        });
        changed = true;
      }
    }

    const graph = this.#store.get(conversationId);
    if (!graph) return;
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    let running = graph.nodes.filter((node) => node.status === "running").length;
    for (const node of graph.nodes) {
      if (running >= this.#concurrency) break;
      if (node.status !== "pending") continue;
      if (!node.dependsOn.every((dep) => byId.get(dep)?.status === "completed")) continue;
      this.#start(conversationId, node, byId);
      running += 1;
    }

    const nodes = this.#store.get(conversationId)?.nodes ?? [];
    const active = nodes.some((node) => !dagNodeFinished(node.status));
    if (active) this.#settledNotified.delete(conversationId);
    // Read before the waiters are released below: a wait that this very change ends means the
    // main agent is about to read the results itself.
    const awaited = [...this.#waiters.values()].includes(conversationId);
    this.#notify();
    if (
      !active &&
      nodes.length > 0 &&
      !awaited &&
      !this.#settledNotified.has(conversationId) &&
      this.#ranSinceSettled.has(conversationId) &&
      dagGraphState(nodes) !== "stopped"
    ) {
      this.#settledNotified.add(conversationId);
      this.#ranSinceSettled.delete(conversationId);
      this.#onSettled?.(conversationId, nodes);
    }
  }

  #start(conversationId: string, node: DagNode, byId: Map<string, DagNode>): void {
    const key = keyOf(conversationId, node.id);
    const controller = new AbortController();
    this.#running.set(key, controller);
    this.#ranSinceSettled.add(conversationId);
    const attempt = (node.attempt ?? 0) + 1;
    this.#store.patch(conversationId, node.id, {
      status: "running",
      startedAt: Date.now(),
      endedAt: undefined,
      error: undefined,
      attempt,
      runId: dagRunId(node.id, attempt),
    });
    const prompt = buildPrompt(node, node.dependsOn.map((dep) => byId.get(dep)).filter((dep): dep is DagNode => Boolean(dep)));
    const started = this.#store.node(conversationId, node.id) ?? node;
    void this.#run({ conversationId, node: started, prompt, signal: controller.signal })
      .catch((error: unknown): DagNodeRun => ({
        status: "failed",
        output: "",
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        this.#running.delete(key);
        const reason = this.#cancelling.get(key);
        this.#cancelling.delete(key);
        const cancelled = reason !== undefined || result.status === "aborted";
        // 图在运行期间被删了（会话被删）：没有地方可写。
        if (!this.#store.get(conversationId)) {
          this.#resumeWanted.delete(key);
          return;
        }
        if (this.#resumeWanted.delete(key) && cancelled) {
          this.#resetNode(conversationId, node.id);
          this.#pump(conversationId);
          return;
        }
        this.#store.patch(conversationId, node.id, {
          status: cancelled ? "cancelled" : result.status === "completed" ? "completed" : "failed",
          output: result.output || undefined,
          error: cancelled ? (reason ?? result.error ?? "已取消") : result.status === "failed" ? (result.error ?? "子 agent 运行失败") : undefined,
          endedAt: Date.now(),
          ...(result.model ? { model: result.model } : {}),
        });
        this.#pump(conversationId);
      });
  }

  #notify(): void {
    for (const check of [...this.#waiters.keys()]) check();
  }
}

const keyOf = (conversationId: string, id: string): string => `${conversationId}\u0000${id}`;

/** 子 agent 看到的完整任务：自己的说明，加上每个上游节点的产出。 */
export function buildPrompt(node: DagNode, upstream: readonly DagNode[]): string {
  const parts = [node.instruction.trim()];
  const handoffs = upstream.filter((dep) => dep.output?.trim());
  if (handoffs.length > 0) {
    parts.push(
      "## 上游任务的结果\n以下是你依赖的任务已经完成的产出，直接使用，不必重做：",
      ...handoffs.map((dep) => {
        const output = dep.output!.trim();
        const shown = output.length > HANDOFF_LIMIT ? `${output.slice(0, HANDOFF_LIMIT)}\n…（已截断）` : output;
        return `### ${dep.id} ${dep.title}\n${shown}`;
      }),
    );
  }
  parts.push("完成后用一段话汇报结果：你的最后一段话会原样交给依赖你的任务。");
  return parts.join("\n\n");
}
