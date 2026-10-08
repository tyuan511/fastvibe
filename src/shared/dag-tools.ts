/**
 * What the main agent may do to its DAG of sub-agent tasks (the `dag_*` tools).
 *
 * Main implements exactly these actions (`src/main/dag-tools.ts`); the extension
 * (`resources/extensions/dag.ts`) cannot import `@shared` — built-in extensions ship as loose
 * files — so it names them again in its tool schemas.
 */
export const DAG_TOOL_ACTIONS = ["add", "status", "result", "wait", "cancel", "resume", "retry"] as const;
export type DagToolAction = (typeof DAG_TOOL_ACTIONS)[number];

export function isDagToolAction(value: unknown): value is DagToolAction {
  return typeof value === "string" && (DAG_TOOL_ACTIONS as readonly string[]).includes(value);
}

export type DagHostRequest = {
  action: string;
  input?: Record<string, unknown>;
};

export type DagHostResult = { ok: true; value: unknown } | { ok: false; error: string };
