import { useEffect, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Cancel01Icon,
  InformationCircleIcon,
  InformationSquareIcon,
  Target01Icon,
  TaskDaily01Icon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session";
import { TuiLines } from "./tui-lines";

/**
 * Status keys FastVibe renders with its own chrome instead of the generic text
 * line above the composer: `plan-mode` becomes a badge beside the permission
 * control, `goal` becomes the `GoalPanel`.
 */
const BADGE_STATUS_KEYS = new Set(["plan-mode", "goal", "goal-armed"]);

async function runExtensionCommand(command: string): Promise<void> {
  try {
    await window.fastvibe.engine.prompt(command);
  } catch {
    // The engine may be busy; the UI updates once the command runs.
  }
}

function StatusBadge({
  icon,
  label,
  title,
  className,
  disabled,
  onClear,
}: {
  icon: typeof TaskDaily01Icon;
  label: string;
  title: string;
  className?: string;
  disabled?: boolean;
  onClear: () => void;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-7 min-w-0 max-w-40 shrink items-center gap-1 rounded-full border pr-1 pl-2 text-xs",
        className,
      )}
    >
      <HugeiconsIcon strokeWidth={2} icon={icon} className="size-3.5 shrink-0" />
      <span title={label} className="hidden min-w-0 flex-1 truncate @min-[27.5rem]/composer:inline">
        {label}
      </span>
      <button
        type="button"
        aria-label={title}
        title={title}
        disabled={disabled}
        className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-foreground/10 disabled:opacity-40"
        onClick={onClear}
      >
        <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3" />
      </button>
    </span>
  );
}

/**
 * Mode badges, rendered in the composer next to the permission control: plan mode
 * and goal mode armed (a bare `/goal` waiting for the objective). Each close button
 * dispatches the matching command — `/plan` exits plan mode and restores the tools,
 * `/goal clear` drops the armed goal.
 */
export function ExtensionStatusBadges({ disabled }: { disabled?: boolean }): JSX.Element | null {
  const planActive = useSessionStore((state) => Boolean(state.extensionStatus["plan-mode"]));
  const goalArmed = useSessionStore((state) => Boolean(state.extensionStatus["goal-armed"]));
  if (!planActive && !goalArmed) return null;
  return (
    <>
      {planActive ? (
        <StatusBadge
          icon={TaskDaily01Icon}
          label="计划模式"
          title="退出计划模式"
          className="border-info/30 bg-info/10 text-info"
          disabled={disabled}
          onClear={() => void runExtensionCommand("/plan")}
        />
      ) : null}
      {goalArmed ? (
        <StatusBadge
          icon={Target01Icon}
          label="目标模式"
          title="取消目标模式"
          className="border-primary/30 bg-primary/10 text-primary"
          disabled={disabled}
          onClear={() => void runExtensionCommand("/goal clear")}
        />
      ) : null}
    </>
  );
}

type GoalState = "running" | "paused" | "complete";

type GoalPayload = {
  objective: string;
  status: GoalState;
  round: number;
  max?: number;
};

const GOAL_STATUS: Record<GoalState, { label: string; className: string }> = {
  running: { label: "进行中", className: "text-primary" },
  paused: { label: "已暂停", className: "text-warning" },
  complete: { label: "已完成", className: "text-success" },
};

/** The `goal` status is a JSON payload published by the goal extension. */
function parseGoal(raw?: string): GoalPayload | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GoalPayload>;
    if (typeof value.objective !== "string" || !value.objective) return null;
    const status: GoalState =
      value.status === "paused" || value.status === "complete" ? value.status : "running";
    return {
      objective: value.objective,
      status,
      round: typeof value.round === "number" ? value.round : 0,
      max: typeof value.max === "number" ? value.max : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Long-term goal control panel, shown above the composer: the objective, its
 * progress, and view / pause / clear actions that dispatch the goal command.
 */
export function GoalPanel({ className, disabled }: { className?: string; disabled?: boolean }): JSX.Element | null {
  const raw = useSessionStore((state) => state.extensionStatus["goal"]);
  const [expanded, setExpanded] = useState(false);
  const goal = parseGoal(raw);
  if (!goal) return null;
  const meta = GOAL_STATUS[goal.status];
  return (
    <div className={cn("mx-auto w-full max-w-3xl px-6", className)}>
      <div className="rounded-xl border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <HugeiconsIcon strokeWidth={2} icon={Target01Icon} className="size-4 shrink-0 text-primary" />
          <span className="text-sm font-medium">目标</span>
          <Badge variant="secondary" className={meta.className}>
            {meta.label}
          </Badge>
          <span className="text-xs text-muted-foreground">
            第 {goal.round} 轮{goal.max ? ` / ${goal.max}` : ""}
          </span>
          <div className="flex-1" />
          <Button size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起" : "查看"}
          </Button>
          {goal.status === "paused" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => void runExtensionCommand("/goal resume")}
            >
              继续
            </Button>
          ) : goal.status === "running" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => void runExtensionCommand("/goal pause")}
            >
              暂停
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={disabled}
            onClick={() => void runExtensionCommand("/goal clear")}
          >
            清除
          </Button>
        </div>
        <p className={cn("mt-1.5 text-xs leading-5 text-muted-foreground", !expanded && "line-clamp-2")}>
          {goal.objective}
        </p>
      </div>
    </div>
  );
}

/**
 * Status entries and string-line widgets an extension published via
 * `ctx.ui.setStatus()` / `ctx.ui.setWidget()`, rendered just above the composer.
 *
 * Plan- and goal-mode statuses are excluded: FastVibe draws those as its own
 * badge / control panel.
 */
export function ExtensionWidgets({ className }: { className?: string }): JSX.Element | null {
  const status = useSessionStore((state) => state.extensionStatus);
  const widgets = useSessionStore((state) => state.extensionWidgets);
  const statusEntries = Object.entries(status).filter(([key, text]) => text && !BADGE_STATUS_KEYS.has(key));
  const widgetEntries = Object.values(widgets);
  if (statusEntries.length === 0 && widgetEntries.length === 0) return null;
  return (
    <div className={cn("mx-auto w-full max-w-3xl space-y-1.5 px-6", className)}>
      {statusEntries.map(([key, text]) => (
        <div key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
          <HugeiconsIcon strokeWidth={2} icon={InformationSquareIcon} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{text}</span>
        </div>
      ))}
      {widgetEntries.map((widget) => (
        <div
          key={widget.key}
          className="overflow-x-auto rounded-xl border border-border bg-card px-3 py-2 font-mono text-xs leading-4 text-muted-foreground"
        >
          {widget.runs && widget.runs.length > 0 ? (
            <TuiLines runs={widget.runs} />
          ) : (
            widget.lines.map((line, index) => (
              <div key={index} className="whitespace-pre">
                {line || "\u00a0"}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

/** Transient extension notices (`ctx.ui.notify()`), stacked bottom-right. */
export function ExtensionNotices(): JSX.Element | null {
  const notices = useSessionStore((state) => state.notices);
  const dismissNotice = useSessionStore((state) => state.dismissNotice);

  useEffect(() => {
    if (notices.length === 0) return;
    const timers = notices.map((notice) => window.setTimeout(() => dismissNotice(notice.id), 6000));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [notices, dismissNotice]);

  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-1.5">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-sm",
            notice.level === "error" && "border-destructive/40 text-destructive",
            notice.level === "warning" && "text-warning",
          )}
        >
          <HugeiconsIcon
            strokeWidth={2}
            icon={notice.level === "info" ? InformationCircleIcon : Alert02Icon}
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{notice.message}</span>
          <button
            type="button"
            aria-label="关闭通知"
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-muted"
            onClick={() => dismissNotice(notice.id)}
          >
            <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
