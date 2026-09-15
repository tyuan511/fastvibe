import { useState, type DragEvent, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  DragDropVerticalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { cn } from "@/lib/utils";
import type { QueuePauseReason, QueuedPrompt } from "@shared/types";

const PAUSE_COPY: Record<QueuePauseReason, string> = {
  stopped: "由于你中断了当前响应，队列已暂停",
  error: "由于当前响应出错，队列已暂停（内容未丢失）",
};

/**
 * Follow-up queue stacked on the composer: a rounded-top tray that tucks under
 * the input card, one numbered row per pending message. Rows are drag-and-drop
 * reorderable so the user can reshuffle what gets sent next.
 */
export function MessageQueue({
  items,
  pauseReason,
  draft,
  onRemove,
  onEdit,
  onSendNow,
  onReorder,
  onResume,
}: {
  items: QueuedPrompt[];
  pauseReason: QueuePauseReason | null;
  draft: string;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onResume: () => void;
}): JSX.Element | null {
  const [hint, setHint] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  if (items.length === 0) return null;

  function handleEdit(id: string): void {
    if (draft.trim()) {
      setHint("请先发送或清空当前草稿，再编辑队列消息。");
      return;
    }
    setHint(null);
    onEdit(id);
  }

  function handleDragStart(event: DragEvent<HTMLLIElement>, id: string): void {
    setDragId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }

  function handleDragOver(event: DragEvent<HTMLLIElement>, id: string): void {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragId !== id) onReorder(dragId, id);
  }

  return (
    <div
      data-queue-count={items.length}
      className={cn(
        "relative z-0 w-full overflow-hidden rounded-t-2xl border border-border bg-card p-1.5",
        "-mb-7 pb-9",
      )}
    >
      {pauseReason ? (
        <div className="mb-1 flex min-h-8 items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs">
          <HugeiconsIcon
            strokeWidth={2}
            icon={Alert02Icon}
            className="size-3.5 shrink-0 text-warning"
          />
          <span className="min-w-0 flex-1 truncate text-foreground">{PAUSE_COPY[pauseReason]}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={onResume}
          >
            继续
          </Button>
        </div>
      ) : null}
      {hint ? (
        <p className="px-2.5 pb-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
      <ul className="space-y-0.5">
        {items.map((item, index) => (
          <li
            key={item.id}
            draggable
            onDragStart={(event) => handleDragStart(event, item.id)}
            onDragOver={(event) => handleDragOver(event, item.id)}
            onDrop={(event) => event.preventDefault()}
            onDragEnd={() => setDragId(null)}
            className={cn(
              "group/queue flex h-8 items-center gap-1.5 rounded-lg py-0 pr-1 pl-1.5 transition-colors hover:bg-muted/60",
              dragId === item.id && "opacity-50",
            )}
          >
            <span
              aria-hidden
              title="拖动调整顺序"
              className="flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/40 transition-colors group-hover/queue:text-muted-foreground active:cursor-grabbing"
            >
              <HugeiconsIcon strokeWidth={2} icon={DragDropVerticalIcon} className="size-3.5" />
            </span>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={item.text}>
              {item.text}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="gap-1 text-muted-foreground group-hover/queue:text-foreground"
              onClick={() => onSendNow(item.id)}
            >
              <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} className="size-3.5" />
              立即
            </Button>
            <IconButton
              variant="ghost"
              size="icon-xs"
              label="编辑"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => handleEdit(item.id)}
            >
              <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-3.5" />
            </IconButton>
            <IconButton
              variant="ghost"
              size="icon-xs"
              label="移除待发送消息"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onRemove(item.id)}
            >
              <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
