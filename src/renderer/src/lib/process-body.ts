/**
 * How a transcript fold behaves when what it reveals is taller than the reading area.
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
 * Half the scrollport, not half the window: the transcript's height is the window minus
 * its header and the composer, and no CSS unit reaches it from inside the column, so
 * `MessageList` publishes it on the viewport as `--thread-height` and this reads it. The
 * `100svh` fallback only matters before that first measure.
 *
 * **The gutter is reserved, because the bar is not an overlay.** The app's own scrollbar is
 * a classic 11px bar that takes layout space, so the moment a body's content crosses the cap
 * the bar appears and steals 11px of width (measured: `clientWidth` 672 → 661), every row
 * re-lays-out narrower, and anything sitting on that edge overflows sideways — which is what
 * made a horizontal bar flash for a frame when a fold was opened or closed. `scrollbar-gutter:
 * stable` reserves the 11px whether or not the bar is there, so the width never moves. And a
 * fold body never scrolls sideways at all: the transcript above it is the only thing that
 * does, and every row inside is expected to wrap (`overflow-x-hidden` is the promise, the
 * gutter is the mechanism).
 *
 * **One scroll layer, not two.** A capped body can sit inside another one — a tool batch
 * lives in the 「用时 …」 fold — and both capping is what drew a scrollbar around a
 * scrollbar. Each body therefore carries `PROCESS_BODY_MARK`, and the rule in `index.css`
 * hands the inner one's bound back to the outer: the outer scrolls, the inner contributes
 * its full height. A body that is not nested keeps its own cap, which is what bounds a
 * tool batch during a live run, when there is no fold above it yet.
 *
 * The scrollbar is the app's own (see 滚动条 in AGENTS.md), so nothing here may set
 * `scrollbar-width` / `scrollbar-color` — either one silently repaints the platform bar.
 */
export const PROCESS_BODY_CAP =
  "max-h-[calc(var(--thread-height,100svh)/2)] overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]";

/** Marks a capped body, so a nested one can give its bound up to the outer. */
export const PROCESS_BODY_MARK = "data-process-body";
