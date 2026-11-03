import type { JSX } from "react";
import { FastVibeMascot, type FastVibeMascotPalette, type FastVibeMascotStatus } from "@/components/fastvibe-mascot";
import type { BotConversationCardStatus } from "@/lib/bot-conversation-card";

const APPEARANCE: Record<BotConversationCardStatus, { palette: FastVibeMascotPalette; status: FastVibeMascotStatus }> = {
  queued: { palette: "grape", status: "thinking" },
  working: { palette: "sky", status: "working" },
  waiting: { palette: "peach", status: "waiting" },
  paused: { palette: "cloud", status: "idle" },
  completed: { palette: "mint", status: "success" },
  failed: { palette: "peach", status: "error" },
  interrupted: { palette: "cloud", status: "error" },
  blocked: { palette: "peach", status: "waiting" },
  unconfirmed: { palette: "grape", status: "thinking" },
  idle: { palette: "grape", status: "idle" },
};

/** The card and its conversation header share Vivi's colour and expression. */
export function BotConversationAvatar({ status, size = "size-8" }: { status: BotConversationCardStatus; size?: string }): JSX.Element {
  return <FastVibeMascot {...APPEARANCE[status]} size={size} motion={false} />;
}
