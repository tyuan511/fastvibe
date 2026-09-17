import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Archive04Icon, ArchiveRestoreIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { IconButton } from "@/components/icon-button";
import { formatRelativeTime } from "@/lib/time";
import { restoreConversations, useArchivedIds } from "@/stores/archive";
import { useSessionStore } from "@/stores/session";
import type { Conversation } from "@shared/types";

/** Only deletions need a second confirmation; restoring is non-destructive. */
type ConfirmTarget = { kind: "selection"; ids: string[] } | { kind: "single"; id: string; title: string };

/**
 * What the shell actually managed to delete. It is a whitelist on purpose: a
 * conversation is only dropped from the archive list once the engine confirms it
 * is gone, so a failed delete can never masquerade as a restore.
 */
export type DeleteConversationsResult = { deleted: string[]; error?: string };

function sortArchived(a: Conversation, b: Conversation): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/**
 * Management surface for archived conversations: the sidebar hides them, and
 * this pane is where they are listed, restored, or deleted (individually,
 * multi-selected, or all at once). Every delete goes through a confirm dialog.
 */
export function ArchivedSettings({
  onDeleteConversations,
}: {
  /** Deletes the given conversations in the engine and re-syncs the shell. */
  onDeleteConversations?: (ids: string[]) => Promise<DeleteConversationsResult>;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const conversations = useSessionStore((state) => state.conversations);
  const projects = useSessionStore((state) => state.projects);
  const archived = useArchivedIds();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const items = useMemo(
    () => conversations.filter((item) => archived.has(item.id)).sort(sortArchived),
    [conversations, archived],
  );
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  // Selection is derived from the live list so a deleted or restored chat can
  // never stay "selected" invisibly.
  const selectedIds = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected]);
  const allSelected = ids.length > 0 && selectedIds.length === ids.length;

  useEffect(() => {
    setSelected((prev) => {
      const stale = [...prev].some((id) => !ids.includes(id));
      return stale ? new Set(ids.filter((id) => prev.has(id))) : prev;
    });
  }, [ids]);

  function toggle(id: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function restore(removeIds: string[]): void {
    restoreConversations(removeIds);
    setNotice(removeIds.length ? { kind: "info", text: t("archived.restored", { count: removeIds.length }) } : null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of removeIds) next.delete(id);
      return next;
    });
  }

  async function runDelete(target: ConfirmTarget): Promise<void> {
    const removeIds = target.kind === "single" ? [target.id] : target.ids;
    if (removeIds.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = onDeleteConversations
        ? await onDeleteConversations(removeIds)
        : { deleted: [], error: t("archived.deleteUnavailable") };
      // Only ids the engine confirmed as deleted leave the archive list: a delete
      // that did not happen must never look like a successful restore.
      if (outcome.deleted.length > 0) {
        restoreConversations(outcome.deleted);
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of outcome.deleted) next.delete(id);
          return next;
        });
      }
      const failed = removeIds.length - outcome.deleted.length;
      if (outcome.deleted.length > 0 && failed === 0) {
        setNotice({ kind: "info", text: t("archived.deleted", { count: outcome.deleted.length }) });
      } else {
        setNotice({
          kind: "error",
          text: t("archived.deletePartial", { failed, detail: outcome.error ? `（${outcome.error}）` : "" }),
        });
      }
    } catch (err) {
      setNotice({
        kind: "error",
        text: t("archived.deleteFailed", { detail: err instanceof Error ? `（${err.message}）` : "" }),
      });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const pendingCount = confirm?.kind === "single" ? 1 : (confirm?.ids.length ?? 0);

  return (
    <div className="space-y-4">
      <p className="px-1 text-xs leading-4 text-muted-foreground">
        {t("archived.intro")}
      </p>

      {notice ? (
        <Alert variant={notice.kind === "error" ? "destructive" : "default"} className="px-3 py-2">
          <HugeiconsIcon strokeWidth={2} icon={notice.kind === "error" ? AlertCircleIcon : ArchiveRestoreIcon} />
          <AlertDescription className="text-xs">{notice.text}</AlertDescription>
        </Alert>
      ) : null}

      {items.length === 0 ? (
        <Empty className="border border-solid border-border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon strokeWidth={2} icon={Archive04Icon} />
            </EmptyMedia>
            <EmptyTitle>{t("archived.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("archived.emptyDesc")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Label className="gap-2 text-xs font-normal text-muted-foreground">
              <Checkbox
                checked={allSelected}
                disabled={busy}
                onCheckedChange={(checked) => setSelected(checked ? new Set(ids) : new Set())}
              />
              {t("archived.selectAll")}
              <span className="text-xs">{t("archived.selected", { selected: selectedIds.length, total: items.length })}</span>
            </Label>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || selectedIds.length === 0}
                onClick={() => restore(selectedIds)}
              >
                <HugeiconsIcon strokeWidth={2} icon={ArchiveRestoreIcon} />
                {t("archived.restoreSelected")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || selectedIds.length === 0}
                onClick={() => setConfirm({ kind: "selection", ids: selectedIds })}
              >
                <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                {t("archived.deleteSelected")}
              </Button>
            </div>
          </div>

          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {items.map((item) => {
              const project = projects.find((entry) => entry.cwd === item.project);
              return (
                <div key={item.id} className="group/row flex items-center gap-3 px-4 py-2.5">
                  <Checkbox
                    checked={selected.has(item.id)}
                    disabled={busy}
                    aria-label={t("archived.selectItem", { title: item.title })}
                    onCheckedChange={(checked) => toggle(item.id, checked)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{item.title}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {project?.name ?? t("archived.noProject")} · {formatRelativeTime(item.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                    <IconButton
                      size="icon-xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      label={t("archived.restore")}
                      disabled={busy}
                      onClick={() => restore([item.id])}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={ArchiveRestoreIcon} className="size-3.5" />
                    </IconButton>
                    <IconButton
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive"
                      label={t("archived.delete")}
                      disabled={busy}
                      onClick={() => setConfirm({ kind: "single", id: item.id, title: item.title })}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} className="size-3.5" />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "single" ? t("archived.confirmSingle") : t("archived.confirmMany", { count: pendingCount })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "single"
                ? t("archived.confirmSingleDesc", { title: confirm.title })
                : t("archived.confirmManyDesc", { count: pendingCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("archived.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => confirm && void runDelete(confirm)}
            >
              {t("archived.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
