import type { DagGraph, DagNode } from "../../../shared/dag.ts";
import type { ToolCallBlock } from "../../../shared/types.ts";

/** The node ids a finished dag_add_tasks call created, in the owning engine's vocabulary. */
export function addedDagIds(tool: ToolCallBlock): string[] {
  if (tool.name !== "dag_add_tasks" || tool.status === "running" || !tool.result?.trim().startsWith("{")) return [];
  try {
    const parsed = JSON.parse(tool.result) as { added?: Array<{ id?: unknown }> };
    return (parsed.added ?? []).flatMap((item) => (typeof item.id === "string" ? [item.id] : []));
  } catch {
    return [];
  }
}

/** Never search other conversations: every engine can have its own T-0001. */
export function dagBatch(
  graph: DagGraph | undefined,
  conversationId: string | null | undefined,
  ids: readonly string[],
): { conversationId: string; nodes: DagNode[] } | null {
  if (!conversationId || !graph || graph.conversationId !== conversationId || ids.length === 0) return null;
  const wanted = new Set(ids);
  const nodes = graph.nodes.filter((node) => wanted.has(node.id));
  return nodes.length > 0 ? { conversationId, nodes } : null;
}
