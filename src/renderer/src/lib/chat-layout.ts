/**
 * 消息宽度 (设置 → 通用 → 外观): the transcript rail's max-width. `default` keeps
 * the `max-w-3xl` (48rem) reading column; `wide` is one step up; `widest` caps at
 * 100% of the column — never beyond — so the `px-6` rail padding stands as the
 * only margins.
 */
export type ChatMessageWidth = "default" | "wide" | "widest";

export const CHAT_MESSAGE_WIDTHS: readonly ChatMessageWidth[] = ["default", "wide", "widest"];

export function isChatMessageWidth(value: unknown): value is ChatMessageWidth {
  return value === "default" || value === "wide" || value === "widest";
}

const CHAT_COLUMN_MAX: Record<ChatMessageWidth, string> = {
  default: "48rem",
  wide: "56rem",
  // 100%, not `none`: a cap that always resolves against the column, so the rail
  // can never stretch past it — including where `w-full` is not what sizes it.
  widest: "100%",
};

/** Write the rail width onto `<html>` for the `chat-column` utility (index.css). */
export function applyChatMessageWidth(width: ChatMessageWidth): void {
  document.documentElement.style.setProperty("--chat-column-max", CHAT_COLUMN_MAX[width]);
}

/**
 * Width of the conversation-resources docking probe: the rail plus its 2×1rem
 * padding, before the 600px of panel + insets. Widest leaves no gutter to dock
 * into — the caller gates on that, so the value here is never read.
 */
export function chatColumnDockProbe(width: ChatMessageWidth): string {
  return `calc(${width === "default" ? "50rem" : "58rem"} + 600px)`;
}

/** Shared horizontal rail for transcript rows and composer-adjacent cards. */
export const CHAT_COLUMN_CLASS = "chat-column mx-auto w-full px-6";
