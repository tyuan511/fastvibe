/**
 * 子 agent 任务编排：主 agent 动态生成一张 DAG，子 agent 按依赖关系自主执行。
 *
 * 一个会话至多一张图。主 agent 可以随时再追加节点（新节点可以依赖已有节点），所以这张图是
 * 「长出来的」，而不是一次性写好的计划。节点就是一次子 agent 运行：自己的 profile（名字、
 * 指令、可用工具）、自己的任务说明、依赖的节点；模型跟随主 agent。
 */

export const DAG_NODE_STATUSES = ["pending", "running", "completed", "failed", "skipped", "cancelled"] as const;
export type DagNodeStatus = (typeof DAG_NODE_STATUSES)[number];

/** 终态：不会再变（除非被显式重试）。 */
export function dagNodeFinished(status: DagNodeStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

/** 子 agent 能被授予的工具。写文件 / 执行命令的要由主 agent 明确给出，默认只读。 */
export const DAG_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;
export const DAG_READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export type DagProfile = {
  /** 角色名，显示用，如 `backend-reviewer`。 */
  name: string;
  description?: string;
  /** 这个子 agent 的系统指令。主 agent 为这一个节点现写的，或取自复用的已配置角色。 */
  instructions: string;
  /** 缺省为只读工具。 */
  tools?: string[];
};

/**
 * 一个已经配置好的子 Agent（设置 → 子 Agent），动态编排可以按名字复用它。
 *
 * 复用的是它的全部：系统指令、工具、模型、推理强度。`model` 缺省表示这个角色自己没有
 * 指定模型，运行时跟随主 agent。
 */
export type DagConfiguredAgent = {
  /** 角色名，也是主 agent 在 `agent` 字段里写的那个名字。 */
  name: string;
  description?: string;
  instructions: string;
  tools?: string[];
  /** `provider/id`；缺省跟随主 agent。 */
  model?: string;
  thinkingLevel?: string;
};

export type DagNode = {
  /** `T-0001` 形式，见 `formatDagId`。引擎内唯一；每次运行的 id 见 `runId`。 */
  id: string;
  title: string;
  /** 交给子 agent 的任务说明。依赖节点的产出由调度器在运行时拼进去。 */
  instruction: string;
  profile: DagProfile;
  dependsOn: string[];
  status: DagNodeStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** 完成时子 agent 的最后一段话，会交给依赖它的节点。 */
  output?: string;
  error?: string;
  /** 被跳过时，是哪个上游节点没成功。 */
  blockedBy?: string;
  /**
   * 这个节点复用的已配置子 Agent 的名字。在的话，角色、工具、模型和推理强度都是那个角色的，
   * 不是为主 agent 这一次现写的。
   */
  agent?: string;
  /** 复用的角色指定的模型 `provider/id`。缺省跟随主 agent。运行结束后这里是实际用的模型。 */
  model?: string;
  /** 复用的角色指定的推理强度；缺省跟随运行时默认。 */
  thinkingLevel?: string;
  /** 第几次运行（重试 / 恢复会再跑）。 */
  attempt?: number;
  /**
   * 当前（或最近一次）运行的 subagent id：第一次是 `T-0001`，之后是 `T-0001.2`、`T-0001.3`…
   * 每次运行一个新 id：子 agent 的状态 reducer 不让一个已结束的 id 再回到运行中，
   * 而侧边的执行视图按 id 累积转写——复用同一个 id 会让重跑显示旧状态、接在旧转写后面。
   */
  runId?: string;
};

export type DagGraph = {
  conversationId: string;
  nodes: DagNode[];
  createdAt: number;
  updatedAt: number;
};

/**
 * 编号：`T-0001`、`T-0002` …。至少四位补零，超过 9999 按实际位数（`T-10000`），不截断。
 * 同一引擎内序号只增不减、跨会话不重复——删掉的编号不会再发出去。不同主机可以重号。
 */
export function formatDagId(seq: number): string {
  return `T-${String(Math.max(1, Math.trunc(seq))).padStart(4, "0")}`;
}

/** 认得 `T-0001`，也认 `t-1`、`T0001`（模型常这么写）。不是编号返回 undefined。 */
export function dagSeq(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^t-?(\d+)$/i.exec(value.trim());
  if (!match) return undefined;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

export function canonicalDagId(value: string): string {
  const seq = dagSeq(value);
  return seq === undefined ? value.trim() : formatDagId(seq);
}

/** 一次运行的 subagent id：第 1 次就是节点编号，之后带上次数。 */
export function dagRunId(nodeId: string, attempt: number): string {
  return attempt <= 1 ? nodeId : `${nodeId}.${attempt}`;
}

/** 节点运行的 id 形状（`T-0001`、`T-0001.2`），渲染层据此不为它们逐个开标签页（图里按需打开）。 */
export function isDagNodeId(value: string): boolean {
  return /^T-\d{4,}(\.\d+)?$/.test(value);
}

export const DAG_LIMITS = {
  /** 一次追加最多几个节点。 */
  batch: 30,
  /** 一张图最多几个节点。 */
  graph: 100,
  titleChars: 120,
  instructionChars: 20000,
  profileInstructionChars: 8000,
} as const;

/** 主 agent 写的一个新节点。`ref` 是这一批里的局部名字，让节点能互相引用而不必先知道编号。 */
export type DagNodeDraft = {
  ref?: string;
  title: string;
  instruction: string;
  /**
   * 复用一个已配置的子 Agent：它的系统指令、工具、模型和推理强度原样用于这个节点，`profile`
   * 被忽略。名字对不上任何已配置角色时，退回 `profile` 现写一个。
   */
  agent?: string;
  /** `agent` 没有命中时才需要。命中时由被复用的角色填上。 */
  profile?: DagProfile;
  /** 这一批里的 `ref`，或已有节点的编号。 */
  dependsOn?: string[];
};

export type ResolvedDraft = {
  ref: string;
  title: string;
  instruction: string;
  profile: DagProfile;
  /** 复用的已配置角色；在的话，模型和推理强度也是它的。 */
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  /** 已经全部换成编号的依赖：批内的 `ref` 在这里是 `batchIndex`。 */
  existingDeps: string[];
  batchDeps: number[];
};

/**
 * 校验并解析一批新节点，不改任何状态。
 *
 * 拒绝：空字段、超限、重复 `ref`、引用不存在的节点、自己依赖自己、批内成环。已有节点不可能
 * 依赖新节点，所以环只可能出现在这一批之内。抛出的错误是写给主 agent 读的，要说清楚哪个节点错在哪。
 */
export function resolveDrafts(
  existing: ReadonlySet<string>,
  drafts: readonly DagNodeDraft[],
  agents: readonly DagConfiguredAgent[] = [],
): ResolvedDraft[] {
  if (drafts.length === 0) throw new Error("tasks 不能为空");
  if (drafts.length > DAG_LIMITS.batch) throw new Error(`一次最多追加 ${DAG_LIMITS.batch} 个节点，收到 ${drafts.length} 个`);
  if (existing.size + drafts.length > DAG_LIMITS.graph) {
    throw new Error(`一张图最多 ${DAG_LIMITS.graph} 个节点（已有 ${existing.size}），请精简任务拆分`);
  }
  const refs = new Map<string, number>();
  const resolved: ResolvedDraft[] = drafts.map((draft, index) => {
    const label = `第 ${index + 1} 个任务${draft.ref ? `（${draft.ref}）` : ""}`;
    const ref = (draft.ref ?? "").trim() || `#${index + 1}`;
    if (refs.has(ref)) throw new Error(`${label}：ref「${ref}」重复`);
    refs.set(ref, index);
    const title = typeof draft.title === "string" ? draft.title.trim() : "";
    const instruction = typeof draft.instruction === "string" ? draft.instruction.trim() : "";
    if (!title) throw new Error(`${label}：缺少 title`);
    if (title.length > DAG_LIMITS.titleChars) throw new Error(`${label}：title 超过 ${DAG_LIMITS.titleChars} 字`);
    if (!instruction) throw new Error(`${label}：缺少 instruction（任务说明）`);
    if (instruction.length > DAG_LIMITS.instructionChars) throw new Error(`${label}：instruction 过长`);
    // 名字命中已配置角色就用它，不再看 profile：复用的是那个角色的指令、工具、模型和推理强度。
    // 大小写不敏感，主 agent 照着名单抄也经常抄错大小写。
    const wanted = typeof draft.agent === "string" ? draft.agent.trim().toLowerCase() : "";
    const configured = wanted ? agents.find((agent) => agent.name.trim().toLowerCase() === wanted) : undefined;
    const profile = configured
      ? {
          name: configured.name,
          description: configured.description,
          instructions: configured.instructions,
          tools: configured.tools,
        }
      : draft.profile;
    const name = typeof profile?.name === "string" ? profile.name.trim() : "";
    const instructions = typeof profile?.instructions === "string" ? profile.instructions.trim() : "";
    if (!name) throw new Error(`${label}：profile.name 不能为空`);
    if (!instructions) throw new Error(`${label}：profile.instructions（子 agent 的指令）不能为空`);
    if (instructions.length > DAG_LIMITS.profileInstructionChars) {
      throw new Error(`${label}：profile.instructions 过长`);
    }
    const requested = profile?.tools?.map((tool) => String(tool).trim()).filter(Boolean);
    // 现写的 profile 写了不存在的工具是主 agent 的笔误，整批退回让它改。复用的角色是用户配的，
    // 它的工具表可以比一个节点能用的更宽（比如 subagent 自己），这种只是这个节点用不上，去掉即可。
    const unknown = requested?.filter((tool) => !(DAG_TOOLS as readonly string[]).includes(tool));
    if (!configured && unknown && unknown.length > 0) {
      throw new Error(`${label}：未知工具 ${unknown.join(", ")}；可用：${DAG_TOOLS.join(", ")}`);
    }
    const tools = configured ? requested?.filter((tool) => (DAG_TOOLS as readonly string[]).includes(tool)) : requested;
    return {
      ref,
      title,
      instruction,
      profile: {
        name,
        ...(profile?.description?.trim() ? { description: profile.description.trim() } : {}),
        instructions,
        ...(tools && tools.length > 0 ? { tools: [...new Set(tools)] } : {}),
      },
      ...(configured ? { agent: configured.name, model: configured.model, thinkingLevel: configured.thinkingLevel } : {}),
      existingDeps: [],
      batchDeps: [],
    };
  });

  drafts.forEach((draft, index) => {
    const target = resolved[index];
    for (const raw of draft.dependsOn ?? []) {
      const dep = String(raw).trim();
      if (!dep) continue;
      const inBatch = refs.get(dep);
      if (inBatch !== undefined) {
        if (inBatch === index) throw new Error(`「${target.ref}」不能依赖自己`);
        if (!target.batchDeps.includes(inBatch)) target.batchDeps.push(inBatch);
        continue;
      }
      const id = canonicalDagId(dep);
      if (!existing.has(id)) {
        throw new Error(`「${target.ref}」依赖的「${dep}」不存在：既不是这一批里的 ref，也不是已有的节点编号`);
      }
      if (!target.existingDeps.includes(id)) target.existingDeps.push(id);
    }
  });

  // 批内成环：Kahn。剩下没被消掉的节点就在环上（或依赖环上的节点）。
  const indegree = resolved.map((node) => node.batchDeps.length);
  const queue = indegree.flatMap((degree, index) => (degree === 0 ? [index] : []));
  let seen = 0;
  while (queue.length > 0) {
    const next = queue.shift()!;
    seen += 1;
    resolved.forEach((node, index) => {
      if (node.batchDeps.includes(next) && --indegree[index] === 0) queue.push(index);
    });
  }
  if (seen < resolved.length) {
    const stuck = resolved.filter((_, index) => indegree[index] > 0).map((node) => node.ref);
    throw new Error(`依赖成环：${stuck.join("、")}`);
  }
  return resolved;
}

/**
 * Where a graph stands, for a header and a 恢复 button. Derived from the nodes — never stored,
 * so it cannot disagree with them after a restart or a retry.
 *
 * `stopped` is the one that can be resumed: something was cancelled (the main chat's Stop, 取消全部,
 * an app quit under a running node) and nothing is running. A graph with only failures is `failed`
 * — those are retried node by node, because a failure is a result, not an interruption.
 */
export type DagGraphState = "running" | "stopped" | "failed" | "completed";

export function dagGraphState(nodes: readonly { status: DagNodeStatus }[]): DagGraphState {
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "cancelled")) return "stopped";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "pending")) return "running";
  return "completed";
}

/**
 * A node's state in the vocabulary of a delegated run, for the execution tab it opens. That tab
 * only reads a run's cached transcript once the run is `completed` / `error` / `aborted` — after
 * a restart nothing else tells it the run is over, so a `failed` or `cancelled` node handed over
 * as-is would sit on an empty pane forever.
 */
export function dagRunStatus(status: DagNodeStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    default:
      return "aborted";
  }
}
