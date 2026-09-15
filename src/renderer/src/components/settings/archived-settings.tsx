import { useEffect, useMemo, useState, type JSX } from "react";
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
    setNotice(removeIds.length ? { kind: "info", text: `已恢复 ${removeIds.length} 个对话到侧边栏。` } : null);
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
        : { deleted: [], error: "删除接口不可用，请重启应用后重试。" };
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
        setNotice({ kind: "info", text: `已删除 ${outcome.deleted.length} 个对话。` });
      } else {
        setNotice({
          kind: "error",
          text: `有 ${failed} 个对话删除失败，仍保留在归档列表。${outcome.error ? `（${outcome.error}）` : ""}`,
        });
      }
    } catch (err) {
      setNotice({
        kind: "error",
        text: `删除失败，对话仍保留在归档列表。${err instanceof Error ? `（${err.message}）` : ""}`,
      });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const pendingCount = confirm?.kind === "single" ? 1 : (confirm?.ids.length ?? 0);

  return (
    <div className="space-y-4">
      <p className="px-1 text-[11.5px] leading-4 text-muted-foreground">
        归档只是把对话从侧边栏收起，内容仍保存在磁盘上；删除会连同会话记录一起移除，无法恢复。
      </p>

      {notice ? (
        <Alert variant={notice.kind === "error" ? "destructive" : "default"} className="px-3 py-2">
          <HugeiconsIcon strokeWidth={2} icon={notice.kind === "error" ? AlertCircleIcon : ArchiveRestoreIcon} />
          <AlertDescription className="text-[12px]">{notice.text}</AlertDescription>
        </Alert>
      ) : null}

      {items.length === 0 ? (
        <Empty className="border border-solid border-border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon strokeWidth={2} icon={Archive04Icon} />
            </EmptyMedia>
            <EmptyTitle>没有已归档的对话</EmptyTitle>
            <EmptyDescription>在侧边栏悬停对话点归档图标，或右键选择「归档」。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Label className="gap-2 text-[12.5px] font-normal text-muted-foreground">
              <Checkbox
                checked={allSelected}
                disabled={busy}
                onCheckedChange={(checked) => setSelected(checked ? new Set(ids) : new Set())}
              />
              全选
              <span className="text-[11.5px]">已选 {selectedIds.length} / {items.length}</span>
            </Label>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || selectedIds.length === 0}
                onClick={() => restore(selectedIds)}
              >
                <HugeiconsIcon strokeWidth={2} icon={ArchiveRestoreIcon} />
                恢复选中
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || selectedIds.length === 0}
                onClick={() => setConfirm({ kind: "selection", ids: selectedIds })}
              >
                <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                删除选中
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
                    aria-label={`选择「${item.title}」`}
                    onCheckedChange={(checked) => toggle(item.id, checked)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{item.title}</p>
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {project?.name ?? "无项目"} · {formatRelativeTime(item.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                    <IconButton
                      size="icon-xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      label="恢复"
                      disabled={busy}
                      onClick={() => restore([item.id])}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={ArchiveRestoreIcon} className="size-3.5" />
                    </IconButton>
                    <IconButton
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive"
                      label="删除"
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
              {confirm?.kind === "single" ? "删除这个对话？" : `删除选中的 ${pendingCount} 个对话？`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "single"
                ? `「${confirm.title}」及其全部消息会从磁盘删除，无法恢复。`
                : `这 ${pendingCount} 个已归档的对话及其全部消息会从磁盘删除，无法恢复。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => confirm && void runDelete(confirm)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
