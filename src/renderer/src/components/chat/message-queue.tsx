import { useEffect, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  DragDropVerticalIcon,
  PencilEdit02Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/icon-button";
import { cn } from "@/lib/utils";
import type { QueuePauseReason, QueuedPrompt } from "@shared/types";

const PAUSE_COPY: Record<QueuePauseReason, string> = {
  stopped: "由于你中断了当前响应，队列已暂停",
  error: "由于当前响应出错，队列已暂停（内容未丢失）",
};

/** Slow, ease-out settle for rows displaced by a drag, matching the sidebar. */
const REORDER_TRANSITION = { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" };
const DROP_ANIMATION: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
};

/** One queue row's body, shared by the sortable row and the drag overlay. */
function QueueRowContent({
  item,
  index,
  overlay,
  onEdit,
  onSendNow,
  onRecall,
  onRemove,
}: {
  item: QueuedPrompt;
  index: number;
  overlay?: boolean;
  onEdit: () => void;
  onSendNow: () => void;
  onRecall: () => void;
  onRemove: () => void;
}): JSX.Element {
  const sending = Boolean(item.sending);
  return (
    <div
      className={cn(
        "group/queue flex h-8 items-center gap-1.5 rounded-lg py-0 pr-1 pl-1.5 transition-colors",
        overlay
          ? "border border-border bg-card shadow-lg ring-1 ring-border"
          : "hover:bg-muted/60",
      )}
    >
      <span
        aria-hidden
        title={sending ? undefined : "拖动调整顺序"}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center text-muted-foreground/40",
          sending
            ? "cursor-default"
            : "cursor-grab transition-colors group-hover/queue:text-muted-foreground active:cursor-grabbing",
        )}
      >
        {sending ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : (
          <HugeiconsIcon strokeWidth={2} icon={DragDropVerticalIcon} className="size-3.5" />
        )}
      </span>
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={item.text}>
        {item.text}
      </span>
      {sending && !overlay ? (
        <span className="shrink-0 text-xs text-muted-foreground">发送中</span>
      ) : null}
      {overlay ? null : sending ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1 text-muted-foreground group-hover/queue:text-foreground"
            onClick={onRecall}
          >
            <HugeiconsIcon strokeWidth={2} icon={Undo02Icon} className="size-3.5" />
            撤回
          </Button>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label="删除"
            className="text-muted-foreground hover:text-foreground"
            onClick={onRemove}
          >
            <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5" />
          </IconButton>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1 text-muted-foreground group-hover/queue:text-foreground"
            onClick={onSendNow}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} className="size-3.5" />
            立即
          </Button>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label="编辑"
            className="text-muted-foreground hover:text-foreground"
            onClick={onEdit}
          >
            <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-3.5" />
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label="移除待发送消息"
            className="text-muted-foreground hover:text-foreground"
            onClick={onRemove}
          >
            <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5" />
          </IconButton>
        </>
      )}
    </div>
  );
}

/**
 * One sortable queue row. dnd-kit's transform/transition animate the neighbours out
 * of the way while `DragOverlay` follows the pointer, so rows swap places live and
 * the source row only holds its slot.
 */
function SortableQueueRow({
  item,
  index,
  onEdit,
  onSendNow,
  onRecall,
  onRemove,
}: {
  item: QueuedPrompt;
  index: number;
  onEdit: () => void;
  onSendNow: () => void;
  onRecall: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: Boolean(item.sending),
    transition: REORDER_TRANSITION,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // The overlay draws the moving row; the source only holds its place.
    opacity: isDragging ? 0 : undefined,
    position: "relative" as const,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <li ref={setNodeRef} style={style} {...(item.sending ? {} : listeners)} className="touch-pan-y">
      <QueueRowContent
        item={item}
        index={index}
        onEdit={onEdit}
        onSendNow={onSendNow}
        onRecall={onRecall}
        onRemove={onRemove}
      />
    </li>
  );
}

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
  onRecall,
  onReorder,
  onResume,
}: {
  items: QueuedPrompt[];
  pauseReason: QueuePauseReason | null;
  draft: string;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onRecall: (id: string) => void;
  /** Persist the full id order the drag produced. */
  onReorder: (ids: string[]) => void;
  onResume: () => void;
}): JSX.Element | null {
  const [hint, setHint] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const sensors = useSensors(
    // A small threshold keeps the row's "立即 / 编辑 / 移除" buttons clickable.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The open editor can outlive its row (the message was removed while editing).
  useEffect(() => {
    if (hint && items.length === 0) setHint(null);
  }, [items.length, hint]);

  if (items.length === 0) return null;

  function handleEdit(id: string): void {
    if (draft.trim()) {
      setHint("请先发送或清空当前草稿，再编辑队列消息。");
      return;
    }
    setHint(null);
    onEdit(id);
  }

  function handleDragStart(event: DragStartEvent): void {
    setDragId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    setDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = items.map((item) => item.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  }

  const activeItem = dragId ? items.find((item) => item.id === dragId) ?? null : null;
  const activeIndex = activeItem ? items.indexOf(activeItem) : 0;

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
            继续发送
          </Button>
        </div>
      ) : null}
      {hint ? (
        <p className="px-2.5 pb-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragId(null)}
      >
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5">
            {items.map((item, index) => (
              <SortableQueueRow
                key={item.id}
                item={item}
                index={index}
                onEdit={() => handleEdit(item.id)}
                onSendNow={() => onSendNow(item.id)}
                onRecall={() => onRecall(item.id)}
                onRemove={() => onRemove(item.id)}
              />
            ))}
          </ul>
        </SortableContext>
        <DragOverlay dropAnimation={DROP_ANIMATION}>
          {activeItem ? (
            <QueueRowContent overlay item={activeItem} index={activeIndex} onEdit={() => undefined} onSendNow={() => undefined} onRecall={() => undefined} onRemove={() => undefined} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
