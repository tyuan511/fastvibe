import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CircleIcon, RecordIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { TodoItem, TodoStatus } from "@/lib/todos";

function StatusIcon({ status }: { status: TodoStatus }): JSX.Element {
  if (status === "completed") {
    return <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    return <HugeiconsIcon strokeWidth={2} icon={RecordIcon} className="size-3.5 shrink-0 text-foreground" />;
  }
  return <HugeiconsIcon strokeWidth={2} icon={CircleIcon} className="size-3.5 shrink-0 text-muted-foreground/50" />;
}

const STATUS_TEXT: Record<TodoStatus, string> = {
  pending: "text-muted-foreground",
  in_progress: "text-foreground",
  completed: "text-muted-foreground/70 line-through",
  cancelled: "text-muted-foreground/50 line-through",
};

/** One checklist row. Used by the tool card and the status panel. */
export function TodoRow({
  item,
  compact = false,
}: {
  item: TodoItem;
  compact?: boolean;
}): JSX.Element {
  return (
    <div
      data-todo-status={item.status}
      className={cn(
        "flex min-w-0 items-start gap-2",
        compact ? "min-h-8 rounded-lg px-2 py-1.5 hover:bg-muted/60" : "py-1",
      )}
    >
      <span className={compact ? "mt-0.5" : "mt-0.5"}>
        <StatusIcon status={item.status} />
      </span>
      <span
        title={item.content}
        className={cn(
          "min-w-0 flex-1 break-words text-[12.5px] leading-5",
          compact && "line-clamp-2",
          STATUS_TEXT[item.status],
        )}
      >
        {item.content}
      </span>
    </div>
  );
}

/** Expanded tool-card body: a quiet surface with the full checklist. */
export function TodoChecklist({ items }: { items: TodoItem[] }): JSX.Element {
  return (
    <div className="space-y-0.5 rounded-xl bg-muted/40 px-3 py-2">
      {items.map((item) => (
        <TodoRow key={item.id} item={item} />
      ))}
    </div>
  );
}
