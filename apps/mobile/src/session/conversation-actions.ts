import { t } from "../i18n";
import { toast } from "../ui/toast";
import { getClient, setArchivedIds, setPermissionAlways, type PermissionPrompt } from "./connection";

/**
 * What can be done to a conversation from the phone — the list's long-press menu and
 * the chat header's ⋯ share these. Each reports its own outcome as a toast; the
 * catalog push is what updates the list afterwards.
 */

function fail(title: string, error: unknown): false {
  toast.error(error instanceof Error && error.message ? t("toast.failedWith", { title, message: error.message }) : title);
  return false;
}

function done(message: string): true {
  toast.success(message);
  return true;
}

export async function renameConversation(id: string, title: string): Promise<boolean> {
  const remote = getClient();
  if (!remote) return false;
  try {
    await remote.call("conversations:rename", { id, title });
    return done(t("toast.renamed"));
  } catch (error) {
    return fail(t("actions.renameFailed"), error);
  }
}

/**
 * Read the machine's archive list before writing it, so another client's archived
 * conversations are never overwritten by this phone's older copy.
 */
async function writeArchived(change: (previous: string[]) => string[]): Promise<void> {
  const remote = getClient();
  if (!remote) throw new Error(t("conn.notConnected"));
  const settings = (await remote.call("settings:get")) as { archivedConversations?: unknown };
  const previous = Array.isArray(settings.archivedConversations)
    ? settings.archivedConversations.filter((item): item is string => typeof item === "string")
    : [];
  const next = change(previous);
  await remote.call("settings:set", { archivedConversations: next });
  setArchivedIds(next);
}

/** Archiving a running chat stops it, as on the desktop. */
export async function archiveConversation(id: string, running: boolean): Promise<boolean> {
  try {
    await writeArchived((previous) => [...new Set([...previous, id])]);
    if (running) await getClient()?.call("engine:abort", { conversationId: id });
    return done(t("toast.archived"));
  } catch (error) {
    return fail(t("actions.archiveFailed"), error);
  }
}

export async function unarchiveConversation(id: string): Promise<boolean> {
  try {
    await writeArchived((previous) => previous.filter((item) => item !== id));
    return done(t("toast.restored"));
  } catch (error) {
    return fail(t("actions.restoreFailed"), error);
  }
}

export async function deleteConversation(id: string): Promise<boolean> {
  const remote = getClient();
  if (!remote) return false;
  try {
    await remote.call("conversations:delete", { id });
    return done(t("toast.deleted"));
  } catch (error) {
    return fail(t("actions.deleteFailed"), error);
  }
}

/** The desktop's rule identity (`lib/permission-rules.ts`): method, title and message. */
export function permissionKey(prompt: Pick<PermissionPrompt, "method" | "title" | "message">): string {
  return `${prompt.method}:${prompt.title ?? ""}:${prompt.message ?? ""}`;
}

/** Add a 始终允许 rule to the machine's settings, where every client reads it. */
export async function rememberPermission(prompt: PermissionPrompt): Promise<void> {
  const remote = getClient();
  if (!remote) return;
  const key = permissionKey(prompt);
  const settings = (await remote.call("settings:get")) as { permissionAlways?: unknown };
  const previous = Array.isArray(settings.permissionAlways)
    ? settings.permissionAlways.filter((item): item is string => typeof item === "string")
    : [];
  if (previous.includes(key)) return;
  const next = [...previous, key];
  await remote.call("settings:set", { permissionAlways: next });
  setPermissionAlways(next);
}
