import { useEffect, useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import {
  Cancel01Icon,
  Delete02Icon,
  InformationSquareIcon,
  PauseIcon,
  PlayIcon,
  Target01Icon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { engine } from "@/lib/engine-client";
import { IconButton } from "@/components/icon-button";
import { cn } from "@/lib/utils";
import { useSessionStore, useExtensionStatus, useExtensionWidgets } from "@/stores/session";
import { TuiLines } from "./tui-lines";

/**
 * Status keys FastVibe renders with its own chrome instead of the generic text
 * line above the composer: `goal` becomes the `GoalPanel`, `goal-armed` a badge
 * beside the permission control, and `handoff` the composer's own placeholder
 * while the summary is written.
 */
const BADGE_STATUS_KEYS = new Set(["goal", "goal-armed", "handoff"]);

async function runExtensionCommand(command: string): Promise<void> {
  try {
    await engine.prompt(command);
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
  icon: typeof Target01Icon;
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
 * Mode badge, rendered in the composer next to the permission control: goal mode
 * armed (a bare `/goal` waiting for the objective). Its close button dispatches
 * `/goal clear`, which drops the armed goal.
 */
export function ExtensionStatusBadges({ disabled }: { disabled?: boolean }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const status = useExtensionStatus();
  if (!status["goal-armed"]) return null;
  return (
    <StatusBadge
      icon={Target01Icon}
      label={t("goal.label")}
      title={t("goal.cancel")}
      className="border-primary/30 bg-primary/10 text-primary"
      disabled={disabled}
      onClear={() => void runExtensionCommand("/goal clear")}
    />
  );
}

type GoalState = "running" | "paused" | "complete";

type GoalPayload = {
  objective: string;
  status: GoalState;
  /** 1-based number of the round the agent is on. */
  round: number;
};

function goalStatusMeta(status: GoalState): { label: string; className: string } {
  const className = status === "running" ? "text-primary" : status === "paused" ? "text-warning" : "text-success";
  return { label: i18n.t(`chat:goal.${status}`) as string, className };
}

/** The `goal` status is a JSON payload published by the goal extension. */
function parseGoal(raw?: string): GoalPayload | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GoalPayload>;
    if (typeof value.objective !== "string" || !value.objective) return null;
    const status: GoalState =
      value.status === "paused" || value.status === "complete" ? value.status : "running";
    // The extension counts rounds from 1 and never reports the cap; an older build
    // wrote a 0-based count, which is the same round under this label.
    const round = typeof value.round === "number" && value.round > 1 ? value.round : 1;
    return { objective: value.objective, status, round };
  } catch {
    return null;
  }
}

/**
 * Long-term goal control, shown above the composer as a single row: the target
 * glyph, the status, the round, then the objective — which keeps whatever width is
 * left and ellipsises — and the pause/resume + clear actions as icon buttons.
 *
 * One line, not a card: it sits in the composer slot next to the todo panel, and the
 * objective is usually a sentence rather than a paragraph. The full text is the
 * title attribute, so the truncated middle of a long objective is still reachable.
 */
export function GoalPanel({ className, disabled }: { className?: string; disabled?: boolean }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const raw = useExtensionStatus()["goal"];
  const goal = parseGoal(raw);
  if (!goal) return null;
  const meta = goalStatusMeta(goal.status);
  return (
    <div className={cn("mx-auto w-full max-w-3xl px-6", className)}>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5">
        {/* The target glyph names the panel — 「目标」 only restated the icon that
            already leads the row (and read larger than the chrome beside it). */}
        <span
          role="img"
          aria-label={t("goal.title")}
          title={t("goal.title")}
          className="flex size-4 shrink-0 items-center justify-center text-primary"
        >
          <HugeiconsIcon strokeWidth={2} icon={Target01Icon} className="size-4" />
        </span>
        <Badge variant="secondary" className={cn("shrink-0", meta.className)}>
          {meta.label}
        </Badge>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("goal.round", { round: goal.round })}
        </span>
        <span title={goal.objective} className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {goal.objective}
        </span>
        {goal.status === "paused" ? (
          <IconButton
            size="icon-xs"
            variant="ghost"
            label={t("goal.resume")}
            title={t("goal.resume")}
            disabled={disabled}
            onClick={() => void runExtensionCommand("/goal resume")}
          >
            <HugeiconsIcon strokeWidth={2} icon={PlayIcon} className="size-3.5" />
          </IconButton>
        ) : goal.status === "running" ? (
          <IconButton
            size="icon-xs"
            variant="ghost"
            label={t("goal.pause")}
            title={t("goal.pause")}
            disabled={disabled}
            onClick={() => void runExtensionCommand("/goal pause")}
          >
            <HugeiconsIcon strokeWidth={2} icon={PauseIcon} className="size-3.5" />
          </IconButton>
        ) : null}
        <IconButton
          size="icon-xs"
          variant="ghost"
          label={t("goal.clear")}
          title={t("goal.clear")}
          className="text-destructive hover:text-destructive"
          disabled={disabled}
          onClick={() => void runExtensionCommand("/goal clear")}
        >
          <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * Status entries and string-line widgets an extension published via
 * `ctx.ui.setStatus()` / `ctx.ui.setWidget()`, rendered just above the composer.
 *
 * Goal-mode statuses are excluded: FastVibe draws those as its own badge /
 * control panel.
 */
export function ExtensionWidgets({ className }: { className?: string }): JSX.Element | null {
  const status = useExtensionStatus();
  const widgets = useExtensionWidgets();
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
  const shown = useRef(new Set<string>());

  useEffect(() => {
    for (const notice of notices) {
      if (shown.current.has(notice.id)) continue;
      shown.current.add(notice.id);
      const show = notice.level === "error" ? toast.error : notice.level === "warning" ? toast.warning : toast.info;
      show(notice.message, {
        id: notice.id,
        onDismiss: () => {
          shown.current.delete(notice.id);
          dismissNotice(notice.id);
        },
      });
    }
  }, [notices, dismissNotice]);

  return null;
}
