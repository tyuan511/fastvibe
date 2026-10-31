/** Active tool switches for codemode and deferred tool search. Agent collaboration is always available. */
export const CODEMODE_TOOL = "codemode";
export const TOOL_SEARCH_TOOL = "tool_search";
export type ToolModes = { codemode: boolean; toolSearch: boolean };
export const TOOL_MODE_KEYS = ["codemode", "toolSearch"] as const;
export function toolModes(settings: Record<string, unknown>, servers: ReadonlyArray<{ enabled: boolean; exposure?: string }>): ToolModes {
  const live = servers.filter((server) => server.enabled);
  return { codemode: settings.codemode !== false || live.some((server) => server.exposure === "codemode"), toolSearch: settings.toolSearch !== false || live.some((server) => server.exposure === "deferred") };
}
export function applyToolModes(active: readonly string[], modes: ToolModes): string[] {
  const wanted = new Map([[CODEMODE_TOOL, modes.codemode], [TOOL_SEARCH_TOOL, modes.toolSearch]]);
  const next = active.filter((name) => wanted.get(name) !== false);
  for (const [name, on] of wanted) if (on && !next.includes(name)) next.push(name);
  return next;
}
export function toolModeSettingsChanged(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return TOOL_MODE_KEYS.some((key) => (previous[key] !== false) !== (next[key] !== false));
}
