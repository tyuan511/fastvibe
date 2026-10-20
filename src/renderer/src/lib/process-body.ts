/**
 * How a transcript fold behaves when what it reveals is taller than the window.
 *
 * A fold's body used to grow as long as its content: open a 「用时 …」 run fold or a
 * batch of consecutive tools, and the reply the fold exists to leave on screen was
 * pushed off the bottom of it. The cap is one rule shared by every fold that can hold
 * a whole run's worth of parts, so those surfaces cannot disagree about how much they
 * are allowed to take:
 *
 *   * `RunCollapse` — a finished run's thinking and tool calls;
 *   * `ProcessOverflow` — the hidden tail of a long live run;
 *   * `ToolRow` in a `ToolGroupRow` — a batch of consecutive tools;
 *   * `UserPromptBubble` — a prompt expanded in place.
 *
 * `min(20rem, 40vh)` is in `rem` on purpose, so 界面字号 scales it with everything
 * else, and the 40vh share keeps part of the answer visible on a short window. The
 * body scrolls inside and takes the app's own scrollbar (see 滚动条 in AGENTS.md), so
 * nothing here may set `scrollbar-width` / `scrollbar-color` — either one silently
 * repaints the platform bar.
 */
export const PROCESS_BODY_CAP = "max-h-[min(20rem,40vh)] overflow-y-auto";
