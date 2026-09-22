import type { AppCapability } from "../../../shared/app-protocol.ts";
import { canUseBinding, decodeRemoteProjectKey, remoteProjectKey, type ProjectBindingState } from "../../../shared/project-binding.ts";
import { decodeScopedId } from "../../../shared/server-scope.ts";
import type { Project } from "../../../shared/types.ts";

/** A namespaced conversation id, project key, or remote file path. */
export function isRemoteRef(value: string | undefined | null): boolean {
  if (!value) return false;
  return decodeScopedId(value) !== null;
}

/**
 * Whether a catalog push should navigate this window.
 *
 * The id on that push is the local catalog's active conversation. It moves when a
 * local draft is discarded or a background session is activated, which is not a
 * request to leave the remote conversation on screen.
 */
export function shouldFollowCatalogActive(input: {
  next: string | null;
  current: string | null;
  intended: string | null;
}): boolean {
  const { next, current, intended } = input;
  if (!next || next === current || next === intended) return false;
  const onRemote = isRemoteRef(current) || isRemoteRef(intended);
  if (onRemote && !isRemoteRef(next)) return false;
  return true;
}

export function isRemoteProject(project: Project | undefined | null): boolean {
  return project?.kind === "remote" || Boolean(project && isRemoteRef(project.cwd));
}

/** The filesystem path a remote ref names, else the string unchanged. */
export function displayRemotePath(path: string): string {
  return decodeRemoteProjectKey(path)?.remoteWorkspaceId
    ?? decodeScopedId(path)?.localId
    ?? path;
}

export function encodeRemoteReadPath(serverInstanceId: string, rawPath: string): string {
  const trimmed = rawPath.trim() || "/";
  const raw = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return remoteProjectKey(serverInstanceId, raw);
}

export function parentRemotePath(rawPath: string): string {
  const trimmed = rawPath.replace(/\/+$/, "") || "/";
  if (trimmed === "/" || trimmed === "") return "/";
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

export function projectHasCapability(project: Project | undefined, capability: AppCapability): boolean {
  if (!isRemoteProject(project)) return true;
  if (project?.bindingState && project.bindingState !== "available") return false;
  if (!project?.capabilities) return true;
  return canUseBinding(project.capabilities, capability);
}

export function bindingStateKey(state: ProjectBindingState | undefined): string {
  switch (state) {
    case "available":
      return "available";
    case "connecting":
      return "connecting";
    case "auth-required":
      return "authRequired";
    case "incompatible":
      return "incompatible";
    case "missing":
      return "missing";
    case "offline":
    default:
      return "offline";
  }
}
