import { useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, CircleIcon, ListChecksIcon, RecordIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { compactTodos, latestTodos, type TodoItem, type TodoStatus } from "@/lib/todos";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session";

function StatusIcon({ status }: { status: TodoStatus }): JSX.Element {
  if (status === "completed") {
    return <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    return <HugeiconsIcon strokeWidth={2} icon={RecordIcon} className="size-3.5 shrink-0 text-foreground" />;
  }
  if (status === "cancelled") {
    return <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5 shrink-0 text-muted-foreground/50" />;
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
          "min-w-0 flex-1 break-words text-sm leading-5",
          compact && "line-clamp-2",
          STATUS_TEXT[item.status],
        )}
      >
        {item.status === "in_progress" && item.activeForm ? item.activeForm : item.content}
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

/**
 * Live checklist above the composer. Reads the latest `todo` tool call in the
 * transcript — hidden once every item is completed or cancelled.
 */
export function TodoPanel({ className }: { className?: string }): JSX.Element | null {
  // Select the transcript itself: `latestTodos` allocates a new array on every
  // call, and Zustand/React's `useSyncExternalStore` treats that as a changed
  // snapshot — "Maximum update depth exceeded" on every paint.
  const messages = useSessionStore((state) => state.messages);
  const items = useMemo(() => latestTodos(messages), [messages]);
  const [expanded, setExpanded] = useState(false);
  const unfinished = items.some((item) => item.status === "pending" || item.status === "in_progress");
  if (!unfinished) return null;

  const done = items.filter((item) => item.status === "completed").length;
  const folded = compactTodos(items);
  const showToggle = folded.compact;
  const open = expanded || !showToggle;

  return (
    <div className={cn("mx-auto w-full max-w-3xl px-6", className)}>
      <div className="rounded-xl border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} className="size-4 shrink-0 text-primary" />
          <span className="text-sm font-medium">待办</span>
          <Badge variant="secondary" className="text-muted-foreground">
            {done}/{items.length}
          </Badge>
          <div className="flex-1" />
          {showToggle ? (
            <Button size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "展开"}
            </Button>
          ) : null}
        </div>
        <div className="mt-1">
          {open ? (
            items.map((item) => <TodoRow key={item.id} item={item} compact />)
          ) : (
            <>
              {folded.preceding.length > 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">以上 {folded.preceding.length} 项</p>
              ) : null}
              {folded.focus.map((item) => (
                <TodoRow key={item.id} item={item} compact />
              ))}
              {folded.following.length > 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">以下 {folded.following.length} 项</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
