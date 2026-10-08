import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dagNodeFinished, dagSeq, formatDagId, type DagGraph, type DagNode } from "../../shared/dag.ts";

type DagFile = {
  version: 1;
  /** 下一个要分配的序号，全局、只增不减。 */
  seq: number;
  graphs: DagGraph[];
};

const VERSION = 1;
/** 一个节点的产出和错误各存多长。依赖它的节点读到的也是这么多——够交接，不够塞满上下文。 */
export const DAG_OUTPUT_LIMIT = 20000;

/**
 * 每个会话的 DAG 图的持久化。
 *
 * 和 `ConversationCatalog` 一样，所有写入走同一个 `#write()`：它去抖落盘，也是唯一通知
 * `onChange` 的地方，所以侧边的图和落盘的永远是同一份。图和节点一律返回副本。
 *
 * 编号计数器单独存：只看现有节点推算会在删除后把最大号再发出去，而编号同时是子 agent 运行的 id。
 */
export class DagStore {
  #file: string;
  #graphs = new Map<string, DagGraph>();
  #seq = 1;
  #writeTimer: NodeJS.Timeout | null = null;
  /** 每次变更后收到该会话的图（被删时为 null）。构造之后再设置。 */
  onChange: ((conversationId: string, graph: DagGraph | null) => void) | null = null;

  constructor(file: string) {
    this.#file = file;
    this.#read();
  }

  list(): DagGraph[] {
    return [...this.#graphs.values()].map(copy);
  }

  get(conversationId: string): DagGraph | undefined {
    const graph = this.#graphs.get(conversationId);
    return graph ? copy(graph) : undefined;
  }

  node(conversationId: string, id: string): DagNode | undefined {
    const node = this.#graphs.get(conversationId)?.nodes.find((item) => item.id === id);
    return node ? { ...node, dependsOn: [...node.dependsOn] } : undefined;
  }

  /** 为一批新节点分配编号并加入图。返回新节点（已带编号）。 */
  append(conversationId: string, make: (allocate: () => string) => Array<Omit<DagNode, "createdAt">>): DagNode[] {
    const now = Date.now();
    const created = make(() => formatDagId(this.#seq++)).map((node): DagNode => ({ ...node, createdAt: now }));
    const graph = this.#graphs.get(conversationId) ?? { conversationId, nodes: [], createdAt: now, updatedAt: now };
    graph.nodes.push(...created);
    graph.updatedAt = now;
    this.#graphs.set(conversationId, graph);
    this.#write(conversationId);
    return created.map((node) => ({ ...node, dependsOn: [...node.dependsOn] }));
  }

  /** 改一个节点。`patch` 里值为 `undefined` 的键被清除。 */
  patch(conversationId: string, id: string, patch: Partial<DagNode>): DagNode | undefined {
    const graph = this.#graphs.get(conversationId);
    const node = graph?.nodes.find((item) => item.id === id);
    if (!graph || !node) return undefined;
    for (const [key, value] of Object.entries(patch) as Array<[keyof DagNode, unknown]>) {
      if (value === undefined) delete (node as Record<string, unknown>)[key];
      else (node as Record<string, unknown>)[key] = key === "output" || key === "error" ? clip(String(value)) : value;
    }
    graph.updatedAt = Date.now();
    this.#write(conversationId);
    return { ...node, dependsOn: [...node.dependsOn] };
  }

  /** 会话没了，图也没了。 */
  drop(conversationId: string): boolean {
    if (!this.#graphs.delete(conversationId)) return false;
    this.#write(conversationId);
    return true;
  }

  /** 退出时立刻落盘，不让去抖里的写入丢掉。 */
  flush(): void {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    const payload: DagFile = { version: VERSION, seq: this.#seq, graphs: [...this.#graphs.values()] };
    const temp = `${this.#file}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      renameSync(temp, this.#file);
    } catch {
      // 图落盘失败不该让一次运行或一次退出失败；内存里的状态依然是对的。
    }
  }

  #read(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<DagFile>;
      if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.graphs)) return;
      let max = 0;
      let interrupted = false;
      for (const raw of parsed.graphs) {
        const graph = normalizeGraph(raw);
        if (!graph) continue;
        for (const node of graph.nodes) {
          max = Math.max(max, dagSeq(node.id) ?? 0);
          // 应用退出时还没结束的节点不会自己接着跑：把它们标成被中断，而不是永远显示「运行中」。
          if (!dagNodeFinished(node.status)) {
            node.status = "cancelled";
            node.error = "应用退出时被中断";
            node.endedAt = Date.now();
            interrupted = true;
          }
        }
        this.#graphs.set(graph.conversationId, graph);
      }
      this.#seq = Math.max(typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq) ? parsed.seq : 1, max + 1, 1);
      if (interrupted) this.flush();
    } catch {
      // 没有文件、或文件损坏：从空开始，下一次写入会覆盖它。
    }
  }

  #write(conversationId: string): void {
    this.onChange?.(conversationId, this.get(conversationId) ?? null);
    if (this.#writeTimer) clearTimeout(this.#writeTimer);
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.flush();
    }, 40);
    this.#writeTimer.unref?.();
  }
}

function clip(text: string): string {
  return text.length > DAG_OUTPUT_LIMIT ? `${text.slice(0, DAG_OUTPUT_LIMIT)}\n…（已截断）` : text;
}

function copy(graph: DagGraph): DagGraph {
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn], profile: { ...node.profile } })) };
}

function normalizeGraph(raw: unknown): DagGraph | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<DagGraph>;
  if (typeof value.conversationId !== "string" || !value.conversationId || !Array.isArray(value.nodes)) return undefined;
  const nodes = value.nodes.filter(
    (node): node is DagNode =>
      Boolean(node) &&
      typeof node === "object" &&
      typeof (node as DagNode).id === "string" &&
      dagSeq((node as DagNode).id) !== undefined &&
      typeof (node as DagNode).title === "string" &&
      Array.isArray((node as DagNode).dependsOn) &&
      typeof (node as DagNode).profile?.name === "string",
  );
  const now = Date.now();
  return {
    conversationId: value.conversationId,
    nodes,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
  };
}
