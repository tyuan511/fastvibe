import type { MemoryDetail, MemoryEdgeOrigin, MemoryGraph, MemoryGraphEdge, MemoryGraphNode, MemoryItem, MemoryRelationView } from "@shared/memory";

/**
 * A small memory graph for 设置 → 长期记忆 → 关系图 in the browser preview: two projects,
 * every relation view and every stage that writes edges (write-time judgement, time
 * order, consolidation, fallback), a fallback-written memory and a System-Two summary.
 */

const FASTVIBE = "/Users/demo/code/fastvibe";
const WEBSITE = "/Users/demo/code/website";
const START = new Date(2026, 8, 23, 20, 0).getTime();
const MINUTE = 60_000;

type Seed = [role: MemoryItem["role"], project: string, content: string, entities: string[]];

const SEEDS: Seed[] = [
  ["user", FASTVIBE, "给长期记忆加一个 JEV 增强模式，按论文 Jev-Mem 来做。", ["Jev", "Jev-Mem"]],
  ["assistant", FASTVIBE, "已新增 JEV 增强记忆：写入时分类型并建语义、时间、因果、实体四种关系，检索时按预算扩展并判断证据是否充分。", ["Jev"]],
  ["user", FASTVIBE, "review 一下当前 Jev 增强记忆的实现是否与论文一致。", ["Jev"]],
  ["assistant", FASTVIBE, "发现所有问题都没有带说明文字，Jev 分不出题目；hops 的数值换算也写错了。", ["Jev"]],
  ["user", FASTVIBE, "先对照下官方仓库再对齐下。", []],
  ["assistant", FASTVIBE, "已按官方仓库移植：问题原文、阈值、预算分配、停止条件和打分权重都与参考实现一致。", ["Jev-Mem"]],
  ["user", FASTVIBE, "降级写入也要调用大模型提取信息，并和最相似的 3 条记忆相连。", []],
  ["assistant", FASTVIBE, "降级写入已完成：大模型提取叙述、实体、关键词和情绪，并连上时间前驱与 3 个最相似的记忆。", []],
  ["user", FASTVIBE, "你记忆里面有啥", []],
  ["assistant", FASTVIBE, "我能看到的记忆主要是当前对话里的内容。", []],
  ["user", FASTVIBE, "这个直接去查数据库了不太对吧", []],
  ["assistant", FASTVIBE, "已新增 memory_search 与 memory_recent 两个只读工具，并在系统提示里说明长期记忆。", ["FastVibe"]],
  ["user", FASTVIBE, "添加上 jev 决策引擎和记忆相关的内容吧", ["README"]],
  ["assistant", FASTVIBE, "已在中英 README 中补充决策引擎与记忆两部分。", ["README"]],
  ["user", FASTVIBE, "我更喜欢回答用中文，少用英文术语。", []],
  ["summary", FASTVIBE, "用户在推进 FastVibe 的 JEV 增强记忆：先按论文实现，再对照官方仓库逐项对齐，并补齐降级写入与记忆工具。", ["Jev", "FastVibe"]],
  ["user", WEBSITE, "首页的主题色换成深蓝。", []],
  ["assistant", WEBSITE, "已把首页主题色改为深蓝，并同步到暗色主题。", []],
  ["user", WEBSITE, "部署到 Cloudflare Pages。", ["Cloudflare Pages"]],
  ["assistant", WEBSITE, "已配置 Cloudflare Pages 自动部署。", ["Cloudflare Pages"]],
];

const NODES: Array<MemoryGraphNode & { content: string; entities: string[] }> = SEEDS.map(([role, project, content, entities], index) => ({
  id: `m${String(index).padStart(2, "0")}`,
  role,
  kind: role === "summary" ? "semantic" : role === "user" ? "task" : "episode",
  createdAt: START + index * 7 * MINUTE,
  preview: content.slice(0, 160),
  content,
  entities,
  project,
  conversationId: project === FASTVIBE ? (index < 9 ? "c-jev" : "c-tools") : "c-site",
  ...(index === 7 ? { fallback: true } : {}),
}));

function edge(source: number, target: number, view: MemoryRelationView, relation: MemoryGraphEdge["relation"], origin: MemoryEdgeOrigin, weight: number): MemoryGraphEdge {
  return { sourceId: NODES[source].id, targetId: NODES[target].id, view, relation, origin, weight };
}

const EDGES: MemoryGraphEdge[] = [
  // Time order inside each conversation.
  ...[[0, 8], [9, 15], [16, 19]].flatMap(([from, to]) => Array.from({ length: to - from }, (_unused, step) => [
    edge(from + step, from + step + 1, "temporal", "before", "sequence", 0.5),
    edge(from + step + 1, from + step, "temporal", "after", "sequence", 0.5),
    ...(step > 0 ? [edge(from + step - 1, from + step + 1, "temporal", "temporally_close", "sequence", 0.5)] : []),
  ]).flat()),
  // Write-time judgements.
  edge(1, 0, "semantic", "related", "jev", 0.91),
  edge(3, 1, "semantic", "related", "jev", 0.78),
  edge(2, 3, "causal", "causes", "jev", 0.82),
  edge(4, 5, "causal", "causes", "jev", 0.88),
  edge(5, 3, "semantic", "related", "jev", 0.73),
  edge(6, 7, "causal", "causes", "jev", 0.9),
  edge(10, 11, "causal", "causes", "jev", 0.86),
  edge(9, 8, "semantic", "related", "jev", 0.8),
  edge(11, 9, "semantic", "related", "jev", 0.64),
  edge(12, 13, "causal", "causes", "jev", 0.93),
  edge(13, 12, "entity", "same_entity", "jev", 1),
  edge(1, 0, "entity", "same_entity", "jev", 1),
  edge(2, 1, "entity", "same_entity", "jev", 1),
  edge(5, 0, "entity", "same_entity", "jev", 0.72),
  edge(18, 19, "entity", "same_entity", "jev", 1),
  edge(18, 19, "causal", "causes", "jev", 0.89),
  edge(17, 16, "semantic", "related", "jev", 0.84),
  // The summary went through the full write path.
  edge(15, 0, "semantic", "related", "jev", 0.87),
  edge(15, 5, "semantic", "related", "jev", 0.83),
  edge(15, 11, "entity", "same_entity", "jev", 1),
  // Consolidation of m14 (the 20th write in this fixture's story).
  edge(14, 9, "semantic", "related", "consolidation", 0.86),
  edge(14, 13, "semantic", "duplicates", "consolidation", 0.9),
  // The fallback write: predecessor in time and its three nearest neighbours.
  edge(6, 7, "temporal", "before", "magma", 0.5),
  edge(7, 6, "temporal", "after", "magma", 0.5),
  edge(7, 5, "semantic", "related", "magma", 0.5),
  edge(5, 7, "semantic", "related", "magma", 0.5),
  edge(7, 3, "semantic", "related", "magma", 0.5),
  edge(3, 7, "semantic", "related", "magma", 0.5),
];

const lightNode = ({ content: _content, entities: _entities, ...node }: (typeof NODES)[number]): MemoryGraphNode => node;

export function memoryGraphFixture(project?: string): MemoryGraph {
  const nodes = NODES.filter((node) => !project || node.project === project);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes: nodes.map(lightNode).reverse(),
    edges: EDGES.filter((item) => ids.has(item.sourceId) && ids.has(item.targetId)),
    projects: [FASTVIBE, WEBSITE],
    total: nodes.length,
  };
}

export const MEMORY_FIXTURE_COUNTS = { items: NODES.length, edges: EDGES.length };

export function memoryDetailFixture(id: string): MemoryDetail | null {
  const node = NODES.find((item) => item.id === id);
  if (!node) return null;
  const index = NODES.indexOf(node);
  const summary = node.role === "summary";
  const item: MemoryDetail["item"] = {
    id: node.id,
    role: node.role,
    kind: node.kind,
    content: node.content,
    createdAt: node.createdAt,
    importance: node.role === "user" ? 0.75 : 0.55,
    confidence: 0.8,
    project: node.project,
    conversationId: node.conversationId,
    typeScores: summary
      ? { episodic: 0.2, semantic: 0.94, procedural: 0.31, preference: 0.08 }
      : { episodic: 0.35 + (index % 5) * 0.12, semantic: 0.6 - (index % 3) * 0.15, procedural: index % 4 === 1 ? 0.72 : 0.1, preference: index === 14 ? 0.96 : 0.05 },
    entities: node.entities,
    keywords: node.content.match(/[A-Za-z][A-Za-z-]+|[一-鿿]{2}/g)?.slice(0, 6) ?? [],
    metadata: {
      ...(node.fallback ? { narrative: "用户确认降级写入需要调用大模型提取信息，助手完成了实现。", emotion: "平静", jevMem: { controller: "magma_fallback" } } : {}),
      ...(summary ? { source: "jev_mem_consolidation", sourceMemoryIds: ["m00", "m05"], consolidationAction: "promote" } : {}),
      ...(index === 14 ? {
        jevMem: {
          consolidation: [
            { candidateId: "m09", redundant: 0.12, contradiction: 0.04, obsolete: 0.1, link: 0.86, representation: { choice: "keep_separate", probabilities: { keep_separate: 0.8, merge: 0.1, promote: 0.05, uncertain: 0.05 } } },
            { candidateId: "m13", redundant: 0.9, contradiction: 0.02, obsolete: 0.2, link: 0.4, representation: { choice: "merge", probabilities: { keep_separate: 0.05, merge: 0.9, promote: 0.03, uncertain: 0.02 } } },
          ],
        },
      } : {}),
    },
  };
  const relations = EDGES.filter((relation) => relation.sourceId === id || relation.targetId === id).map((relation) => {
    const direction = relation.sourceId === id ? "out" as const : "in" as const;
    const neighbor = NODES.find((other) => other.id === (direction === "out" ? relation.targetId : relation.sourceId))!;
    return { edge: relation, direction, neighbor: lightNode(neighbor) };
  });
  return { item, relations };
}
