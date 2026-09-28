/**
 * The desktop App Server may expose projects and conversations reached through its SSH
 * bindings. They use the shared `remote:<server>:<local>` shape, but they are still
 * ordinary selectable rows for a mobile client because calls are routed by that desktop
 * App Server. Keep the validators structural so malformed catalog rows are ignored.
 */
export function isRemoteCatalogReference(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("remote:");
}

export function isMobileProject(value: Record<string, unknown>): boolean {
  return typeof value.cwd === "string" && typeof value.name === "string";
}

export function isMobileConversation(value: Record<string, unknown>): boolean {
  return typeof value.id === "string";
}
