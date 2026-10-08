/**
 * Whether `codemode`, `tool_search` and the dynamic-DAG tools are switched on for a session.
 *
 * `codemode` and `tool_search` are registered by the SDK's extensions but start inactive (and an
 * SDK session loads neither extension by itself). The `dag_*` tools are registered active by the
 * built-in extension; this module's job is still only their entry in the active set, which is
 * what gets declared to the model. All three are **on by default**: the settings keys are read as
 * "off only when explicitly `false`", so an install that never wrote them has all of them. Two
 * things keep a tool on:
 *
 *   - the user's own switch — 设置 → 偏好设置 → 对话 (`codemode` / `toolSearch`) and
 *     设置 → 子 Agent (`dynamicDag`) — and
 *   - an enabled MCP server whose `exposure` can only be reached through that tool. A server set
 *     to `codemode` has no declared tools at all without `codemode`, and one set to `deferred` has
 *     none until `tool_search` loads them, so the choice implies the tool even with its switch off
 *     — the same rule pi's own MCP support applies when a server connects. Nothing implies the
 *     DAG tools; the switch is the only thing that does.
 *
 * It is recomputed on every `session_start`, `reload` included, from the settings as they are then;
 * switching one off takes effect on the next reload, which the engine schedules itself (see
 * `PiProcessManager.refreshToolModes`).
 */

export const CODEMODE_TOOL = "codemode";
export const TOOL_SEARCH_TOOL = "tool_search";

/** The main agent's graph tools. Names match `resources/extensions/dag.ts`; that file cannot import this. */
export const DAG_AGENT_TOOLS = [
  "dag_add_tasks",
  "dag_status",
  "dag_result",
  "dag_wait",
  "dag_cancel",
  "dag_resume",
  "dag_retry",
] as const;

export type ToolModes = { codemode: boolean; toolSearch: boolean; dynamicDag: boolean };

/** The settings keys that decide the result; the settings writer compares exactly these. */
export const TOOL_MODE_KEYS = ["codemode", "toolSearch", "dynamicDag"] as const;

export function toolModes(
  settings: Record<string, unknown>,
  servers: ReadonlyArray<{ enabled: boolean; exposure?: string }>,
): ToolModes {
  const live = servers.filter((server) => server.enabled);
  return {
    codemode: settings.codemode !== false || live.some((server) => server.exposure === "codemode"),
    toolSearch: settings.toolSearch !== false || live.some((server) => server.exposure === "deferred"),
    dynamicDag: settings.dynamicDag !== false,
  };
}

/**
 * `active` with these tools added or removed to match `modes`. Everything else keeps its
 * place, so a tool another extension (plan mode, say) narrowed the set to stays narrowed.
 */
export function applyToolModes(active: readonly string[], modes: ToolModes): string[] {
  const wanted = new Map<string, boolean>([
    [CODEMODE_TOOL, modes.codemode],
    [TOOL_SEARCH_TOOL, modes.toolSearch],
    ...DAG_AGENT_TOOLS.map((name) => [name, modes.dynamicDag] as const),
  ]);
  const next = active.filter((name) => wanted.get(name) !== false);
  for (const [name, on] of wanted) if (on && !next.includes(name)) next.push(name);
  return next;
}

/** Whether a settings write changed anything that decides `toolModes`. Absent reads as on. */
export function toolModeSettingsChanged(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return TOOL_MODE_KEYS.some((key) => (previous[key] !== false) !== (next[key] !== false));
}
