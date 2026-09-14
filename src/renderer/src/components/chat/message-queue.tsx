import { useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, PencilEdit02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { QueuePauseReason, QueuedPrompt } from "@shared/types";

const PAUSE_COPY: Record<QueuePauseReason, string> = {
  stopped: "由于你中断了当前响应，队列已暂停",
  error: "由于当前响应出错，队列已暂停（内容未丢失）",
};

/**
 * Follow-up queue stacked on the composer, matching zcode's `S0e` layout:
 * a rounded-top tray that tucks under the input card, one row per pending
 * message, with send-now / edit / remove.
 */
export function MessageQueue({
  items,
  pauseReason,
  draft,
  onRemove,
  onEdit,
  onSendNow,
  onResume,
}: {
  items: QueuedPrompt[];
  pauseReason: QueuePauseReason | null;
  draft: string;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onResume: () => void;
}): JSX.Element | null {
  const [hint, setHint] = useState<string | null>(null);
  if (items.length === 0) return null;

  function handleEdit(id: string): void {
    if (draft.trim()) {
      setHint("请先发送或清空当前草稿，再编辑队列消息。");
      return;
    }
    setHint(null);
    onEdit(id);
  }

  return (
    <div
      data-queue-count={items.length}
      className={cn(
        "relative z-0 w-full overflow-hidden rounded-t-2xl border border-border bg-card p-1",
        "-mb-7 pb-7",
      )}
    >
      {pauseReason ? (
        <div className="mb-1 flex min-h-10 items-center gap-3 rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-[12.5px] text-foreground">
          <span className="min-w-0 flex-1">{PAUSE_COPY[pauseReason]}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onResume}
          >
            继续
          </Button>
        </div>
      ) : null}
      {hint ? (
        <p className="mb-1 px-2.5 text-[11.5px] text-muted-foreground">{hint}</p>
      ) : null}
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="relative flex items-center gap-2 rounded-xl px-1.5 py-1 pr-1 transition-colors hover:bg-muted/40"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-[12.5px] text-foreground" title={item.text}>
              <span className="truncate">{item.text}</span>
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 gap-1"
              onClick={() => onSendNow(item.id)}
            >
              <HugeiconsIcon strokeWidth={2} icon={PlayIcon} className="size-3.5" />
              立即
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="编辑"
                    onClick={() => handleEdit(item.id)}
                  >
                    <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>编辑</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="移除待发送消息"
                    onClick={() => onRemove(item.id)}
                  >
                    <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>移除待发送消息</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}
