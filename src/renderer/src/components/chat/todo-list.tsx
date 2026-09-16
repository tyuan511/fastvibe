import { useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Cancel01Icon, CircleIcon, ListChecksIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RunningMark } from "@/components/running-mark";
import { latestTodos, type TodoItem, type TodoStatus } from "@/lib/todos";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session";

function StatusIcon({ status }: { status: TodoStatus }): JSX.Element {
  if (status === "completed") {
    return <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    // The same busy mark the sidebar puts on a running conversation: a plain
    // circle read as an empty radio button, not as motion.
    return <RunningMark className="text-foreground" />;
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

/**
 * One checklist row. Used by the tool card (wrapping, roomy) and the status
 * panel above the composer (`compact` — one line, click-to-expand density).
 */
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
        compact ? "rounded-lg px-2 py-1 hover:bg-muted/60" : "py-1",
      )}
    >
      <span className="mt-0.5">
        <StatusIcon status={item.status} />
      </span>
      <span
        title={item.content}
        className={cn(
          "min-w-0 flex-1 text-sm leading-5",
          compact ? "truncate" : "break-words",
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
 *
 * The composer slot is the scarcest space in the app, so this is a one-line
 * collapsible by default: the header carries the counts plus the single task in
 * progress, and the full checklist is one click away (capped and scrollable).
 */
export function TodoPanel({ className }: { className?: string }): JSX.Element | null {
  // Select the transcript itself: `latestTodos` allocates a new array on every
  // call, and Zustand/React's `useSyncExternalStore` treats that as a changed
  // snapshot — "Maximum update depth exceeded" on every paint.
  const messages = useSessionStore((state) => state.messages);
  const items = useMemo(() => latestTodos(messages), [messages]);
  const [open, setOpen] = useState(false);
  const unfinished = items.some((item) => item.status === "pending" || item.status === "in_progress");
  if (!unfinished) return null;

  const done = items.filter((item) => item.status === "completed").length;
  const running = items.some((item) => item.status === "in_progress");
  // The one item the header shows while folded: what is running, else what is next.
  const active =
    items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");

  return (
    <div className={cn("mx-auto w-full max-w-3xl px-6", className)}>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="rounded-xl border border-border bg-card"
      >
        <CollapsibleTrigger
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 text-left transition-colors",
            "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {running ? (
            <RunningMark className="text-primary" />
          ) : (
            <HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} className="size-4 shrink-0 text-primary" />
          )}
          <span className="shrink-0 text-sm font-medium">待办</span>
          <Badge variant="secondary" className="shrink-0 text-muted-foreground">
            {done}/{items.length}
          </Badge>
          {active ? (
            <span
              title={active.content}
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                active.status === "in_progress" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {active.status === "in_progress" && active.activeForm ? active.activeForm : active.content}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <HugeiconsIcon
            strokeWidth={2}
            aria-hidden
            icon={ArrowRight01Icon}
            className={cn(
              "size-4 shrink-0 text-muted-foreground/60 transition-transform duration-200",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="max-h-40 overflow-auto px-1.5 pb-1.5">
            {items.map((item) => (
              <TodoRow key={item.id} item={item} compact />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
