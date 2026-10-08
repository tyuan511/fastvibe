import { dagNodeFinished, type DagNode, type DagNodeStatus } from "./dag.ts";

const PRIORITY: Record<DagNodeStatus, number> = { blocked: 0, failed: 1, running: 2, pending: 3, cancelled: 4, skipped: 5, completed: 6 };

/** A phone-friendly ownership tree. Dependency edges remain links in the detail view. */
export function dagTaskRows(nodes: readonly DagNode[]): Array<{ node: DagNode; depth: number; previousAttempt: boolean }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | undefined, DagNode[]>();
  for (const node of nodes) {
    const parent = node.parentId && byId.has(node.parentId) ? node.parentId : undefined;
    const group = children.get(parent) ?? [];
    group.push(node); children.set(parent, group);
  }
  const rows: Array<{ node: DagNode; depth: number; previousAttempt: boolean }> = [];
  const seen = new Set<string>();
  const visit = (items: readonly DagNode[], depth: number, retired = false): void => {
    for (const node of [...items].sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const previousAttempt = retired || Boolean(node.parentRunId && node.parentId && byId.get(node.parentId)?.runId !== node.parentRunId);
      rows.push({ node, depth, previousAttempt });
      visit(children.get(node.id) ?? [], depth + 1, previousAttempt);
    }
  };
  visit(children.get(undefined) ?? [], 0);
  // A malformed/older graph must still be readable, never hang on an ownership cycle.
  visit(nodes.filter((node) => !seen.has(node.id)), 0);
  return rows;
}

export function dagProgress(nodes: readonly DagNode[]) {
  return {
    total: nodes.length,
    completed: nodes.filter((node) => node.status === "completed").length,
    active: nodes.filter((node) => !dagNodeFinished(node.status)).length,
    attention: nodes.filter((node) => node.status === "failed" || node.status === "blocked").length,
  };
}
