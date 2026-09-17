import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Cancel01Icon, CircleIcon, ListChecksIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RunningMark } from "@/components/running-mark";
import { activeTodo, latestTodos, todoPosition, type TodoItem, type TodoStatus } from "@/lib/todos";
import { cn } from "@/lib/utils";
import { useConversationWorking, useSessionStore } from "@/stores/session";

function StatusIcon({ status, live }: { status: TodoStatus; live: boolean }): JSX.Element {
  if (status === "completed") {
    return <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    // The same busy mark the sidebar puts on a running conversation: a plain
    // circle read as an empty radio button, not as motion. Only while a run is
    // actually in flight, though — a stopped chat that was interrupted midway
    // through a task must not keep spinning, which would say work is happening
    // when nothing is.
    return live ? (
      <RunningMark className="text-foreground" />
    ) : (
      <HugeiconsIcon strokeWidth={2} icon={CircleIcon} className="size-3.5 shrink-0 text-muted-foreground/50" />
    );
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
  live = false,
}: {
  item: TodoItem;
  compact?: boolean;
  /** Whether a run is in flight in this conversation — see `StatusIcon`. */
  live?: boolean;
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
        <StatusIcon status={item.status} live={live} />
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
  // The checklist is a record of what the model submitted, but its in-progress mark
  // is a claim about *now* — so it follows the conversation, and an idle transcript
  // shows a stalled item as one nothing is working on.
  const live = useConversationWorking();
  return (
    <div className="space-y-0.5 rounded-xl bg-muted/40 px-3 py-2">
      {items.map((item) => (
        <TodoRow key={item.id} item={item} live={live} />
      ))}
    </div>
  );
}

/**
 * Live checklist above the composer. Reads the latest `todo` tool call in the
 * transcript — shown only while this conversation is working, and hidden once every
 * item is completed or cancelled.
 *
 * The composer slot is the scarcest space in the app, so this is a one-line
 * collapsible by default: the header carries the position in the list plus the
 * single task in progress, and the full checklist is one click away (capped and
 * scrollable).
 */
export function TodoPanel({ className }: { className?: string }): JSX.Element | null {
  const { t } = useTranslation("chat");
  // Select the transcript itself: `latestTodos` allocates a new array on every
  // call, and Zustand/React's `useSyncExternalStore` treats that as a changed
  // snapshot — "Maximum update depth exceeded" on every paint.
  const messages = useSessionStore((state) => state.messages);
  const items = useMemo(() => latestTodos(messages), [messages]);
  const [open, setOpen] = useState(false);
  // 「This chat is working」 is this panel's whole premise: an unfinished list is not
  // news once the run that was working through it has stopped — it would sit above
  // the composer with a busy mark, claiming work that is not happening. The plan is
  // still in the transcript's todo card, one collapsed row away.
  const working = useConversationWorking();
  const unfinished = items.some((item) => item.status === "pending" || item.status === "in_progress");
  if (!working || !unfinished) return null;

  const done = items.filter((item) => item.status === "completed").length;
  const inProgress = items.some((item) => item.status === "in_progress");
  // The one item the header shows while folded: what is running, else what is next.
  const active = activeTodo(items);

  return (
    <div className={cn("mx-auto w-full max-w-3xl px-6", className)}>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="rounded-xl border border-border bg-card"
      >
        <CollapsibleTrigger
          title={t("todo.title")}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 text-left transition-colors",
            "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {/* The glyph is the panel's name: a checklist, or the busy mark while an
              item is in progress. A 「待办」 label only restated it — and a CJK
              glyph fills its em box, so the word read a size above the task it sat
              next to. Both glyphs get one 1rem box so the swapping mark keeps the
              column steady. */}
          <span className="flex size-4 shrink-0 items-center justify-center">
            {inProgress ? (
              <RunningMark className="text-primary" />
            ) : (
              <HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} className="size-4 text-primary" />
            )}
          </span>
          <Badge variant="secondary" className="shrink-0 text-muted-foreground" title={t("todo.done", { done, total: items.length })}>
            {todoPosition(items)}/{items.length}
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
              <TodoRow key={item.id} item={item} compact live />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
