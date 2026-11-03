import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { ToolRow } from "@/components/chat/tool-row";
import { WorkingMark } from "@/components/working-mark";
import type { BotProgress } from "@shared/bot";

export const LIVE_PHASES = new Set(["accepted", "understanding", "planning", "delegating", "working", "summarizing"]);

/**
 * Vivi is a person-like assistant, not a job console: while something is going on she says one
 * quiet line («正在处理…») and nothing else. Phases, timers, queues and controls live in the task
 * side pane; stopping is the composer's own stop button.
 */
export function ViviProgressFooter({ progress, sending, fallbackRunning }: {
  progress: BotProgress[]; sending?: boolean; fallbackRunning?: boolean;
}): JSX.Element | null {
  const { t } = useTranslation("app");
  const live = progress.some((item) => LIVE_PHASES.has(item.phase)) || (!progress.length && Boolean(fallbackRunning));
  if (!sending && !live) return null;
  const label = t("viviBot.working");
  return <div data-slot="vivi-progress" className="mb-3 w-full">
    <ToolRow icon={<WorkingMark label={label} />} label={label} running canToggle={false} />
  </div>;
}
