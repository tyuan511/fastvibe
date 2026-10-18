import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { importLegacyJson, RowWriter, type Db } from "./db.ts";
import { DAG_PREVIEW_CHARS, dagNodeFinished, dagOutcomeKey, dagSeq, formatDagId, isDagNodeId, type DagGraph, type DagNode } from "../../shared/dag.ts";

type DagFile = {
  version: 1;
  /** 下一个要分配的序号，全局、只增不减。 */
  seq: number;
  graphs: DagGraph[];
};

const VERSION = 1;
/** Graph previews are bounded; complete outputs live in per-attempt artifact files. */
export const DAG_OUTPUT_LIMIT = DAG_PREVIEW_CHARS;

/** A node row: which conversation owns it (the foreign key), and its place in the graph. */
type NodeRow = { conversationId: string; node: DagNode; position: number };

/** The graph's own fields. Its nodes are rows of their own table, not payload here. */
type GraphHead = Pick<DagGraph, "conversationId" | "createdAt" | "updatedAt" | "revision" | "paused">;

function headOf(graph: DagGraph): GraphHead {
  return {
    conversationId: graph.conversationId,
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
    revision: graph.revision ?? 0,
    paused: graph.paused ?? false,
  };
}

/**
 * 每个会话的 DAG 图的持久化。
 *
 * 和 `ConversationCatalog` 一样，所有写入走同一个 `#write()`：它去抖落盘，也是唯一通知
 * `onChange` 的地方，所以侧边的图和落盘的永远是同一份。图和节点一律返回副本。
 *
 * 编号计数器单独存：只看现有节点推算会在删除后把最大号再发出去，而编号同时是子 agent 运行的 id。
 */
export class DagStore {
  #db: Db;
  #resultsDir: string;
  #graphs = new Map<string, DagGraph>();
  #seq = 1;
  #graphRows: RowWriter<GraphHead>;
  #nodeRows: RowWriter<NodeRow>;
  /** `dag_meta` 里已存的编号，用来说明这次要不要再写一行。 */
  #storedSeq: string | null = null;
  #writeTimer: NodeJS.Timeout | null = null;
  /** 每次变更后收到该会话的图（被删时为 null）。构造之后再设置。 */
  onChange: ((conversationId: string, graph: DagGraph | null) => void) | null = null;

  constructor(db: Db, options: { resultsDir: string; legacyFile?: string }) {
    this.#db = db;
    this.#resultsDir = options.resultsDir;
    this.#graphRows = new RowWriter<GraphHead>(db, {
      table: "dag_graphs",
      identity: (graph) => ({ conversation_id: graph.conversationId }),
      columns: (graph) => ({
        revision: graph.revision ?? 0,
        paused: graph.paused ? 1 : 0,
        created_at: graph.createdAt,
        updated_at: graph.updatedAt,
      }),
      data: (graph) => JSON.stringify(graph),
    });
    this.#nodeRows = new RowWriter<NodeRow>(db, {
      table: "dag_nodes",
      identity: (row) => ({ conversation_id: row.conversationId, id: row.node.id }),
      columns: (row) => ({ position: row.position }),
      data: (row) => JSON.stringify(row.node),
    });
    if (options.legacyFile) {
      importLegacyJson(db, {
        name: "dag",
        file: options.legacyFile,
        // The file's own validation, without the restart rules: the store reads the rows back
        // through `#read`, so an imported graph is judged exactly like a stored one.
        load: (value) => readDagShape(value),
        save: (shape) => {
          // The file's counter wins over whatever the nodes imply; a file that carried none
          // is answered by `#read`, which recomputes it from the rows like any other start.
          this.#writeRows(shape.graphs, shape.seq ?? 1);
          return shape.graphs.length + shape.graphs.reduce((total, graph) => total + graph.nodes.length, 0) + 1;
        },
        count: () =>
          db.countRows("dag_graphs") + db.countRows("dag_nodes") + db.countRows("dag_meta"),
      });
    }
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
    return node ? structuredClone(node) : undefined;
  }

  /** 为一批新节点分配编号并加入图。返回新节点（已带编号）。 */
  append(conversationId: string, make: (allocate: () => string) => Array<Omit<DagNode, "createdAt">>): DagNode[] {
    const now = Date.now();
    const created = make(() => formatDagId(this.#seq++)).map((node): DagNode => ({ ...node, createdAt: now }));
    const graph = this.#graphs.get(conversationId) ?? { conversationId, nodes: [], createdAt: now, updatedAt: now };
    graph.nodes.push(...created);
    graph.updatedAt = now;
    graph.revision = (graph.revision ?? 0) + 1;
    for (const node of created) node.revision = graph.revision;
    this.#graphs.set(conversationId, graph);
    this.#write(conversationId);
    return structuredClone(created);
  }

  /** 改一个节点。`patch` 里值为 `undefined` 的键被清除。 */
  patch(conversationId: string, id: string, patch: Partial<DagNode>): DagNode | undefined {
    const graph = this.#graphs.get(conversationId);
    const node = graph?.nodes.find((item) => item.id === id);
    if (!graph || !node) return undefined;
    // Save before publishing completion. A failed write must not advertise an output that was lost.
    if (patch.output !== undefined) {
      const file = this.#resultFile(conversationId, patch.runId ?? node.runId ?? node.id);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, patch.output, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      patch = { ...patch, outputLength: patch.output.length };
    }
    for (const [key, value] of Object.entries(patch) as Array<[keyof DagNode, unknown]>) {
      if (value === undefined) delete (node as Record<string, unknown>)[key];
      else (node as Record<string, unknown>)[key] = key === "output" || key === "error" ? clip(String(value)) : structuredClone(value);
    }
    graph.updatedAt = Date.now();
    graph.revision = (graph.revision ?? 0) + 1;
    node.revision = graph.revision;
    this.#write(conversationId);
    return structuredClone(node);
  }

  #resultFile(conversationId: string, runId: string): string {
    if (!/^[\w-][\w.-]*$/.test(conversationId) || !isDagNodeId(runId)) throw new Error("Invalid task result id");
    return join(this.#resultsDir, conversationId, `${runId}.txt`);
  }

  output(conversationId: string, node: DagNode, runId = node.runId ?? node.id): string {
    if (runId !== node.id && !new RegExp(`^${node.id}\\.\\d+$`).test(runId)) throw new Error("运行编号不属于这个任务");
    try { return readFileSync(this.#resultFile(conversationId, runId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (runId === (node.runId ?? node.id)) return node.output ?? ""; // Legacy graphs had inline output only.
      throw new Error("没有找到这次运行的产出");
    }
  }

  observe(conversationId: string, nodes: readonly DagNode[]): void {
    for (const node of nodes) {
      const current = this.node(conversationId, node.id);
      if (current && dagNodeFinished(current.status) && dagOutcomeKey(current) === dagOutcomeKey(node) && current.observedOutcome !== dagOutcomeKey(current)) {
        this.patch(conversationId, node.id, { observedOutcome: dagOutcomeKey(current) });
      }
    }
  }

  pause(conversationId: string, paused: boolean): void {
    const graph = this.#graphs.get(conversationId);
    if (graph && graph.paused !== paused) {
      graph.paused = paused;
      this.#write(conversationId);
    }
  }

  /** 会话没了，图也没了。 */
  drop(conversationId: string): boolean {
    if (!this.#graphs.delete(conversationId)) return false;
    if (/^[\w-][\w.-]*$/.test(conversationId)) rmSync(join(this.#resultsDir, conversationId), { recursive: true, force: true });
    this.#write(conversationId);
    return true;
  }

  /** 退出时立刻落盘，不让去抖里的写入丢掉。 */
  flush(): void {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    try {
      this.#db.transaction(() => this.#writeRows([...this.#graphs.values()], this.#seq));
    } catch {
      // 图落盘失败不该让一次运行或一次退出失败；内存里的状态依然是对的。
    }
  }

  /**
   * 图先写、节点后写：`dag_nodes` 的外键要求父行先存在。删掉的图由 `ON DELETE CASCADE`
   * 带走它的节点，节点的写入器随后自己把那些行从记忆里清掉。
   */
  #writeRows(graphs: DagGraph[], seq: number): void {
    this.#graphRows.write(graphs.map(headOf));
    this.#nodeRows.write(
      graphs.flatMap((graph) => graph.nodes.map((node, position) => ({ conversationId: graph.conversationId, node, position }))),
    );
    const text = String(seq);
    if (this.#storedSeq === text) return;
    this.#db.run(
      "INSERT INTO dag_meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      text,
    );
    this.#storedSeq = text;
  }

  #read(): void {
    const shape = readDagShape(this.#rows());
    let max = 0;
    let interrupted = false;
    for (const graph of shape.graphs) {
      for (const node of graph.nodes) {
        max = Math.max(max, dagSeq(node.id) ?? 0);
        // 应用退出时还没结束的节点不会自己接着跑：把它们标成被中断，而不是永远显示「运行中」。
        if (!dagNodeFinished(node.status)) {
          node.status = "cancelled";
          node.error = "应用退出时被中断";
          node.endedAt = Date.now();
          graph.paused = true;
          interrupted = true;
        }
      }
      this.#graphs.set(graph.conversationId, graph);
    }
    this.#seq = Math.max(shape.seq ?? 1, max + 1, 1);
    if (interrupted) this.flush();
  }

  /** 三张表，长成旧 `dag.json` 的样子。 */
  #rows(): unknown {
    const heads = this.#db
      .all<{ data: string }>("SELECT data FROM dag_graphs ORDER BY created_at DESC, conversation_id")
      .map((row) => parse(row.data))
      .filter((item) => item !== undefined);
    const nodeRows = this.#db.all<{ conversation_id: string; data: string }>(
      "SELECT conversation_id, data FROM dag_nodes ORDER BY conversation_id, position, id",
    );
    const nodes = new Map<string, unknown[]>();
    for (const row of nodeRows) {
      const node = parse(row.data);
      if (node === undefined) continue;
      const list = nodes.get(row.conversation_id) ?? [];
      list.push(node);
      nodes.set(row.conversation_id, list);
    }
    const stored = this.#db.get<{ value: string }>("SELECT value FROM dag_meta WHERE key = 'seq'")?.value;
    if (stored !== undefined) this.#storedSeq = stored;
    return {
      version: VERSION,
      seq: stored === undefined ? null : Number(stored),
      graphs: heads.map((head) => ({ ...(head as object), nodes: nodes.get((head as GraphHead).conversationId) ?? [] })),
    };
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

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 旧 `dag.json` 的形状，只做结构校验。导入与读表都走这里，所以两份不会各自解释一遍
 * 「什么样的节点算一个节点」。
 */
function readDagShape(value: unknown): { seq: number | null; graphs: DagGraph[] } {
  const parsed = value as Partial<DagFile> | null;
  if (!parsed || !Array.isArray(parsed.graphs)) return { seq: null, graphs: [] };
  const graphs = parsed.graphs.map(normalizeGraph).filter((graph): graph is DagGraph => graph !== undefined);
  const seq = typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq) ? parsed.seq : null;
  return { seq, graphs };
}

function clip(text: string): string {
  return text.length > DAG_OUTPUT_LIMIT ? `${text.slice(0, DAG_OUTPUT_LIMIT)}\n…（已截断）` : text;
}

function copy(graph: DagGraph): DagGraph { return structuredClone(graph); }

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
    revision: value.revision ?? 0,
    paused: value.paused ?? false,
  };
}
