import type { GitHistoryEntry } from "../../../shared/ipc.ts";

export type GitGraphEdge = { from: number; to: number; color: number; kind: "through" | "in" | "out" };
export type GitGraphRow = { commit: GitHistoryEntry; column: number; color: number; edges: GitGraphEdge[] };
export type GitGraph = { rows: GitGraphRow[]; columns: number };

/** Maintain a lane for every pending ancestor. Only actual parent hashes create edges. */
export function layoutGitGraph(commits: GitHistoryEntry[]): GitGraph {
  let lanes: Array<{ hash: string; color: number }> = [];
  let nextColor = 0;
  let columns = 1;
  const rows: GitGraphRow[] = [];
  for (const commit of commits) {
    let column = lanes.findIndex((lane) => lane.hash === commit.hash);
    const incoming = column >= 0;
    if (!incoming) {
      column = lanes.length;
      lanes.push({ hash: commit.hash, color: nextColor++ });
    }
    const before = [...lanes];
    const color = before[column].color;
    lanes.splice(column, 1);
    const parents = [...new Set(commit.parents)];
    parents.forEach((hash, index) => {
      if (!lanes.some((lane) => lane.hash === hash)) {
        lanes.splice(Math.min(column + index, lanes.length), 0, { hash, color: index === 0 ? color : nextColor++ });
      }
    });
    const edges: GitGraphEdge[] = [];
    before.forEach((lane, index) => {
      if (index === column) return;
      const target = lanes.findIndex((next) => next.hash === lane.hash);
      if (target >= 0) edges.push({ from: index, to: target, color: lane.color, kind: "through" });
    });
    if (incoming) edges.push({ from: column, to: column, color, kind: "in" });
    parents.forEach((hash) => {
      const target = lanes.findIndex((lane) => lane.hash === hash);
      edges.push({ from: column, to: target, color: lanes[target].color, kind: "out" });
    });
    columns = Math.max(columns, before.length, lanes.length);
    rows.push({ commit, column, color, edges });
  }
  return { rows, columns };
}
