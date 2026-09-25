/**
 * The desktop App Server can expose bound workspaces from another App Server in
 * the same catalog. Native mobile is a client of the local App Server only, so
 * those references must not become selectable projects or conversations here.
 *
 * Remote ids and project keys use the shared `remote:<server>:<local>` shape.
 * Keep this check deliberately structural: mobile must also stay safe if a
 * catalog row arrives before its optional `kind` field is decoded.
 */
export function isRemoteCatalogReference(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("remote:");
}

export function isMobileProject(value: Record<string, unknown>): boolean {
  return value.kind !== "remote" && !isRemoteCatalogReference(value.cwd);
}

export function isMobileConversation(value: Record<string, unknown>): boolean {
  return !isRemoteCatalogReference(value.id) && !isRemoteCatalogReference(value.project);
}
