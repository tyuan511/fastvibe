import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { MessageGroup } from "@/components/ui/message";
import {
  MessageRevealProvider,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  VirtualMessageScrollerProvider,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { FLoader } from "@/components/f-loader";
import { stripAttachmentBlock } from "@/lib/attachments";
import { groupMessageRows, type MessageRow } from "@/lib/group-parts";
import { ChatMessageRow } from "./message-row";
import { cn } from "@/lib/utils";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-layout";
import { transcriptDisplay } from "@/lib/transcript-display";
import type { ChatAttachment, ChatMessage } from "@shared/types";
import { SelectionActionBar } from "./selection-action-bar";
import { NewSessionHero } from "./new-session";
import { TurnRail, type TurnMarker } from "./turn-rail";

const PROMPT_LIMIT = 140;
const REPLY_LIMIT = 180;

/**
 * Collapse to a single line and clip, so a mark's preview always fits its card.
 *
 * Only the head of the text is collapsed: the result is at most `limit` characters,
 * so running the whitespace regex over a pasted essay — or over a finished reply —
 * is work thrown away, and `turnMarkers` does it for every turn on every flush. The
 * window is wide enough that only a prefix which is almost entirely whitespace could
 * come up short of the limit, and a text cut by the window keeps its ellipsis.
 */
function clip(text: string, limit: number): string {
  const windowed = text.length > limit * 8;
  const flat = (windowed ? text.slice(0, limit * 8) : text).replace(/\s+/g, " ").trim();
  if (flat.length > limit) return `${flat.slice(0, limit)}…`;
  return windowed && flat ? `${flat}…` : flat;
}

/**
 * Prompt previews, kept per message object.
 *
 * A user row never changes once it is persisted — the store hands back the same
 * object on every flush and every turn-end reload (`reconcileMessages`) — so its
 * preview is computed once instead of at the stream's cadence. `stripAttachmentBlock`
 * is what makes this worth caching: its pattern is anchored at the end of the text,
 * so unlike `clip` it cannot be bounded to a window and has to read the whole prompt.
 */
const promptPreviews = new WeakMap<ChatMessage, string>();

function promptPreview(message: ChatMessage): string {
  const cached = promptPreviews.get(message);
  if (cached !== undefined) return cached;
  const preview = clip(stripAttachmentBlock(message.text), PROMPT_LIMIT);
  promptPreviews.set(message, preview);
  return preview;
}

/**
 * The reply preview stops as soon as it has enough characters, so this stays cheap
 * on every streamed token — merging the whole run would re-join the entire answer
 * just to throw it away.
 */
function replyPreview(row: MessageRow | undefined): string {
  if (!row || row.messages[0].role !== "assistant") return "";
  let text = "";
  for (const message of row.messages) {
    if (!message.text) continue;
    text = text ? `${text} ${message.text}` : message.text;
    if (text.length > REPLY_LIMIT) break;
  }
  return clip(text, REPLY_LIMIT);
}

/** One mark per turn: a user prompt plus the reply it produced. */
function turnMarkers(rows: MessageRow[]): { markers: TurnMarker[]; rowIds: string[] } {
  const markers: TurnMarker[] = [];
  const rowIds = rows.map((row) => row.id);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.messages[0].role !== "user") continue;
    markers.push({
      id: row.id,
      rowIndex: index,
      prompt: promptPreview(row.messages[0]),
      reply: replyPreview(rows[index + 1]),
    });
  }
  return { markers, rowIds };
}

/**
 * Jump back to the live edge whenever the reader sends a new prompt. `autoScroll`
 * only keeps following while they are already at the bottom, so a reader who had
 * scrolled up would otherwise stay parked in history when they hit send.
 */
function FollowLatest({ messages }: { messages: ChatMessage[] }): null {
  const { scrollToEnd } = useMessageScroller();
  const lastUserId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") return messages[index].id;
    }
    return null;
  }, [messages]);
  const seenUserId = useRef<string | null>(lastUserId);

  useEffect(() => {
    if (lastUserId && lastUserId !== seenUserId.current) scrollToEnd();
    seenUserId.current = lastUserId;
  }, [lastUserId, scrollToEnd]);

  return null;
}

/**
 * One user prompt plus the reply it produced — the scope the prompt sticks within.
 * Turns are the unit of the sticky prompt: `position: sticky` only holds a prompt
 * down while its own turn is on screen, so the next turn's prompt pushes it away
 * instead of the first prompt in the thread staying pinned forever.
 */
type Turn = { id: string; rows: MessageRow[] };

function groupTurns(rows: MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  for (const row of rows) {
    const current = turns.at(-1);
    if (row.messages[0].role !== "user" && current) current.rows.push(row);
    else turns.push({ id: row.id, rows: [row] });
  }
  return turns;
}

/**
 * The scroller reads *any* wheel as "the reader took over" and drops out of
 * `following-bottom`; it only re-arms on a scroll event that lands within its 8px
 * bottom threshold. A wheel that cannot move the viewport therefore kills the
 * follow with no scroll event left to restore it — a fling that has already hit
 * the bottom keeps firing momentum wheels against an unchanged `scrollTop`, and a
 * wheel at an idle bottom does the same. The reply then streams off-screen while
 * the reader believes they are still following it. Swallow those no-op wheels in
 * the capture phase, ahead of the scroller's own handler, so the intent never
 * registers. Nothing is `preventDefault`ed: the native scroll, the overscroll
 * behaviour and every wheel that can actually move the viewport are untouched.
 */
const NO_ROOM_SLACK = 2;

function useNoOpWheelGuard(): (node: HTMLDivElement | null) => void {
  const detach = useRef<(() => void) | null>(null);
  return useCallback((node: HTMLDivElement | null) => {
    // React can hand a ref callback a new element without pairing it with a null
    // first, and the scroller merges refs without honouring a returned cleanup, so
    // re-attaching is what unwires the node we were watching before.
    detach.current?.();
    detach.current = null;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY <= 0) return;
      if (node.scrollHeight - node.clientHeight - node.scrollTop > NO_ROOM_SLACK) return;
      event.stopPropagation();
    };
    node.addEventListener("wheel", onWheel, { capture: true, passive: true });
    detach.current = () => node.removeEventListener("wheel", onWheel, { capture: true });
  }, []);
}

/** Sticky rows land on the pixel; anything smaller is sub-pixel jitter. */
const PIN_SLACK = 1;

/** Nearest scrollable ancestor — the thread viewport a prompt pins inside. */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
  }
  return null;
}

type PinWatcher = { turn: HTMLElement; notify: (pinned: boolean) => void };

type PinRegistry = { add: (node: HTMLElement, watcher: PinWatcher) => () => void };

/** One registry per thread viewport, dropped once its last prompt unmounts. */
const pinRegistries = new WeakMap<HTMLElement, PinRegistry>();

/**
 * One scroll listener, one `ResizeObserver` and one animation frame per *thread*,
 * shared by every prompt in it.
 *
 * Each prompt used to wire its own: a long conversation therefore held one scroll
 * listener and two observed nodes per turn, and since one of those nodes is the
 * scroller's shared content — which grows with every streamed token — all of them
 * re-measured on every flush whether the reader was scrolling or not. At a hundred
 * turns that was hundreds of forced layouts per frame to decide a 24px scrim.
 *
 * The batched pass reads the scrollport's edge once and then one rect per prompt,
 * with no writes in between, so the whole thread costs a single layout flush. The
 * `turn` rect stays behind the `&&` — only a row already sitting on the edge, of
 * which there is at most one, pays for it.
 */
function pinRegistryFor(scroller: HTMLElement): PinRegistry {
  const existing = pinRegistries.get(scroller);
  if (existing) return existing;

  const watchers = new Map<HTMLElement, PinWatcher>();
  let frame = 0;

  const measure = (): void => {
    frame = 0;
    const edge = scroller.getBoundingClientRect().top;
    for (const [node, watcher] of watchers) {
      const top = node.getBoundingClientRect().top;
      const pinned =
        Math.abs(top - edge) <= PIN_SLACK &&
        top > watcher.turn.getBoundingClientRect().top + PIN_SLACK;
      watcher.notify(pinned);
    }
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  scroller.addEventListener("scroll", schedule, { passive: true });
  // The turns also move with no scroll event of their own: content streaming into an
  // earlier turn grows the scroller's content, and a resize moves the top edge.
  const observer = new ResizeObserver(schedule);
  observer.observe(scroller);
  const content = scroller.firstElementChild;
  if (content) observer.observe(content);

  const registry: PinRegistry = {
    add(node: HTMLElement, watcher: PinWatcher): () => void {
      watchers.set(node, watcher);
      schedule();
      return () => {
        watchers.delete(node);
        if (watchers.size > 0) return;
        // The last prompt in this thread unmounted; take the shared wiring down
        // with it rather than leaving it observing a detached scroller.
        scroller.removeEventListener("scroll", schedule);
        observer.disconnect();
        if (frame) cancelAnimationFrame(frame);
        pinRegistries.delete(scroller);
      };
    },
  };
  pinRegistries.set(scroller, registry);
  return registry;
}


/**
 * Whether a sticky prompt is currently covering the thread.
 *
 * `position: sticky` reports nothing when it engages, so the geometry is read
 * instead: a pinned row has been pushed below the top of its containing block (its
 * turn) *and* sits on the scrollport's top edge. The class alone cannot decide it —
 * a prompt that merely happens to be first in a thread that never scrolled is
 * covering nothing, and feathering its edge would wash out the first line of the
 * reply underneath it.
 */
function usePinnedPrompt(): { ref: (node: HTMLDivElement | null) => void; pinned: boolean } {
  const [pinned, setPinned] = useState(false);
  const detach = useRef<(() => void) | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => {
    // React can hand a ref callback a new node without pairing it with a null
    // first, so re-attaching is what unwires the previous node.
    detach.current?.();
    detach.current = null;
    if (!node) return;
    const turn = node.parentElement;
    const scroller = scrollParent(node);
    if (!turn || !scroller) return;
    detach.current = pinRegistryFor(scroller).add(node, {
      turn,
      notify: (next) => setPinned((current) => (current === next ? current : next)),
    });
  }, []);

  return { ref, pinned };
}

/**
 * One transcript row. User prompts rise to the top edge and stay there while their
 * own reply is read; the next turn's prompt pushes them away. The solid fill keeps
 * the bubble readable, and a short scrim feathers the seam — but only while the
 * prompt is actually covering something, so a reply's first line is never dimmed at
 * rest. `content-visibility` would take the sticky element out of the scroll flow.
 */
function ThreadRow({
  row,
  last,
  streaming,
  amendable,
  onRetry,
  onEdit,
  onFork,
  showThinking,
  showTimestamp,
  collapseRuns,
}: {
  row: MessageRow;
  last: boolean;
  streaming: boolean;
  amendable: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => void;
  onFork?: (entryId: string) => void;
  showThinking: boolean;
  showTimestamp: boolean;
  collapseRuns: boolean;
}): JSX.Element {
  const isUser = row.messages[0].role === "user";
  const { ref, pinned } = usePinnedPrompt();

  return (
    <MessageScrollerItem
      ref={isUser ? ref : undefined}
      id={row.id}
      messageId={row.id}
      className={cn(
        "[content-visibility:visible]",
        isUser && "relative sticky top-0 z-10 bg-background pt-2",
      )}
    >
      <ChatMessageRow
        messages={row.messages}
        streaming={streaming && last && !isUser}
        onRetry={amendable ? onRetry : undefined}
        onEdit={amendable ? onEdit : undefined}
        onFork={onFork}
        showThinking={showThinking}
        showTimestamp={showTimestamp}
        collapseRuns={collapseRuns}
      />
      {isUser && pinned ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-full h-6 bg-gradient-to-b from-background to-background/0"
        />
      ) : null}
    </MessageScrollerItem>
  );
}

/**
 * The conversation is a variable-height virtual list. Only turns near the viewport
 * are mounted, while TanStack keeps a cheap position estimate for everything else.
 * This is intentionally turn-level: a turn contains the sticky user prompt and all
 * assistant rows that belong to it, so virtualising it cannot split that relationship.
 */
const ROW_ESTIMATE_PX = 180;
/**
 * Extra turns mounted beyond the viewport, per side. One, not more: overscan is counted
 * in *turns*, and one turn can be an agent run of a few hundred messages — four on each
 * side mounted screens of Markdown nobody was looking at, on every switch.
 */
const ROW_OVERSCAN = 1;

/**
 * The turns to mount while a thread is being opened: only its tail, enough to fill the
 * viewport, whatever the scroll offset says.
 *
 * A freshly mounted scroller sits at `scrollTop = 0`, so the virtualizer's own range is the
 * *head* of the thread — which was rendered in full (Markdown, highlighting and all) and
 * thrown away a frame later when the list jumped to the live edge. On a 1,338-message
 * conversation that head was ~450ms of the switch. Sizes come from what the virtualizer has
 * already measured, else the estimate.
 */
function tailRange(count: number, sizes: ReadonlyArray<{ size: number } | undefined>, viewport: number): number[] {
  const indexes: number[] = [];
  let filled = 0;
  for (let index = count - 1; index >= 0; index -= 1) {
    indexes.unshift(index);
    filled += sizes[index]?.size ?? ROW_ESTIMATE_PX;
    if (filled >= viewport) break;
  }
  return indexes;
}

function scrollMetrics(element: HTMLElement): { start: boolean; end: boolean } {
  const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
  return { start: element.scrollTop > 8, end: distance <= 8 + NO_ROOM_SLACK };
}

export function MessageList({
  messages,
  streaming,
  conversationId,
  loading = false,
  loadingReplaces = false,
  onRetry,
  onEdit,
  onFork,
  emptyState,
  onAddSelectionToConversation,
  onAskSelectionInSideChat,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  /** Stable owner of the transcript; required to reset scroll when its first row is reused. */
  conversationId?: string | null;
  loading?: boolean;
  /** Replace the current transcript with the loader, instead of only covering an empty one. */
  loadingReplaces?: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => void;
  /** Omit in read-only/secondary panes so their transcripts cannot fork the main catalog. */
  onFork?: (entryId: string) => void;
  emptyState?: JSX.Element | null;
  onAddSelectionToConversation?: (text: string) => void;
  onAskSelectionInSideChat?: (text: string) => void;
}): JSX.Element {
  const { showThinking, showTimestamp, collapseRuns } = transcriptDisplay();
  const { t } = useTranslation("chat");
  const selectionRootRef = useRef<HTMLDivElement>(null);
  // One row per user prompt and per assistant reply, not per engine message.
  const rows = useMemo(() => groupMessageRows(messages), [messages]);
  // Retry/edit rewind the conversation, so they are only offered on the newest
  // prompt: an older turn's actions would silently discard everything after it.
  const lastUserRowId = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].messages[0].role === "user") return rows[index].id;
    }
    return null;
  }, [rows]);
  const { markers, rowIds } = useMemo(() => turnMarkers(rows), [rows]);
  // Turns scope the sticky prompt; the flat index still decides which row streams.
  const turns = useMemo(() => groupTurns(rows), [rows]);
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  // A ref callback, not a ref object: the scroller only mounts once the thread has
  // rows, which is long after an effect keyed on a ref object would have run.
  const guardViewport = useNoOpWheelGuard();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // The first message is not a conversation identity: it can be reused by a restored,
  // forked or otherwise reconciled transcript. Use the owner id when the caller has one,
  // so switching chats always resets the virtualizer's landing state.
  const threadId = conversationId ?? rows[0]?.id ?? "";
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const rowIndexByMessage = useMemo(() => {
    const index = new Map<string, number>();
    turns.forEach((turn, turnIndex) => {
      for (const row of turn.rows) {
        index.set(row.id, turnIndex);
        for (const message of row.messages) index.set(message.id, turnIndex);
      }
    });
    return index;
  }, [turns]);
  const [scrollState, setScrollState] = useState({ start: false, end: true });
  const followingRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const getScrollElement = useCallback(() => viewportRef.current, []);
  // The thread this list has arrived at the live edge of. Until it has (a switch, or a
  // scroller mounted afresh), only the tail is rendered: see `tailRange`. State rather than
  // a ref so that arriving hands a new `rangeExtractor` to the virtualizer, whose index
  // memo would otherwise keep serving the landing range.
  const [landedThread, setLandedThread] = useState<string | null>(null);
  const landing = landedThread !== threadId;
  const virtualizerRef = useRef<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>(null);
  const rangeExtractor = useCallback((range: Range): number[] => {
    if (!landing) return defaultRangeExtractor(range);
    const viewport = viewportRef.current?.clientHeight || window.innerHeight;
    return tailRange(range.count, virtualizerRef.current?.measurementsCache ?? [], viewport);
  }, [landing]);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
    rangeExtractor,
    // A row measured larger than its estimate re-renders the list. By default that render
    // is forced synchronously (`flushSync`) from inside the measuring pass, which on a switch
    // ran the whole freshly mounted tail twice back to back; letting React batch it costs a
    // frame of settling, not a frozen window.
    useFlushSync: false,
    // Keep the old transcript's vertical breathing room in the virtualizer's coordinate
    // system. `scrollMargin` is an offset relative to the scroll container, not padding;
    // using it with a raw `top: virtualRow.start` would shift every row by 24px.
    paddingStart: 24,
    paddingEnd: 48,
    getItemKey: (index) => `${threadId}:${turnsRef.current[index]?.id ?? index}`,
  });
  virtualizerRef.current = virtualizer;
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const syncScrollState = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    setScrollState((current) => {
      const next = scrollMetrics(element);
      return current.start === next.start && current.end === next.end ? current : next;
    });
  }, []);

  const scrollToEnd = useCallback((options?: { behavior?: ScrollBehavior }): boolean => {
    const element = viewportRef.current;
    if (!element) return false;
    followingRef.current = true;
    programmaticScrollRef.current = true;
    // The DOM is authoritative here. `getTotalSize()` is an estimate while the tail is
    // being measured and can be smaller than the actual scroll range, which leaves a
    // newly opened conversation somewhere above its last message.
    element.scrollTo({
      top: Math.max(0, element.scrollHeight - element.clientHeight),
      behavior: options?.behavior ?? "auto",
    });
    syncScrollState();
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      syncScrollState();
    });
    return true;
  }, [syncScrollState, virtualizer]);

  const scrollToStart = useCallback((options?: { behavior?: ScrollBehavior }): boolean => {
    const element = viewportRef.current;
    if (!element) return false;
    followingRef.current = false;
    programmaticScrollRef.current = true;
    element.scrollTo({ top: 0, behavior: options?.behavior ?? "auto" });
    syncScrollState();
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      syncScrollState();
    });
    return true;
  }, [syncScrollState]);

  const scrollToMessage = useCallback((messageId: string, options?: { align?: "start" | "center" | "end" | "auto" | "nearest"; behavior?: ScrollBehavior }): boolean => {
    const index = rowIndexByMessage.get(messageId);
    if (index === undefined) return false;
    followingRef.current = false;
    // A first render is deliberately tail-only. A rail/search jump is an explicit
    // request for history, so stop the landing extractor before calculating the target
    // range; otherwise the virtualizer scrolls to an unmounted row and leaves a blank.
    if (landing) setLandedThread(threadId);
    virtualizer.scrollToIndex(index, {
      align: options?.align === "nearest" ? "auto" : options?.align ?? "start",
      behavior: options?.behavior ?? "auto",
    });
    window.requestAnimationFrame(syncScrollState);
    return true;
  }, [rowIndexByMessage, syncScrollState, virtualizer]);

  const viewportCallback = useCallback((node: HTMLDivElement | null) => {
    guardViewport(node);
    // A new scroller starts at the top: land again, or its first renders are the head.
    if (node && node !== viewportRef.current) setLandedThread(null);
    viewportRef.current = node;
    if (node) syncScrollState();
  }, [guardViewport, syncScrollState]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = (allowFollowChange: boolean): void => {
      const next = scrollMetrics(element);
      // Re-rendering while a reply streams also re-runs this effect. Its initial read
      // can see the transient gap created by the new text before the follow effect moves
      // the viewport, so only a real scroll event may change the reader's intent.
      if (allowFollowChange && !programmaticScrollRef.current) followingRef.current = next.end;
      setScrollState((current) => current.start === next.start && current.end === next.end ? current : next);
      // Arrived: from here the virtualizer's own range is the right one. Not before — its
      // offset only follows the scroll event, while `scrollToEnd` moves `scrollTop` at once,
      // and this also runs straight from the effect below. Dropping the tail range while
      // the virtualizer still read 0 rendered the head after all.
      // The virtualizer's offset observer can update one task after the native scroll
      // event. The end-distance is the authoritative fact here; waiting for both values
      // to agree could leave a landed list in tail-only mode forever.
      if (landing && next.end) setLandedThread(threadId);
    };
    const onScroll = (): void => update(true);
    element.addEventListener("scroll", onScroll, { passive: true });
    update(false);
    return () => element.removeEventListener("scroll", onScroll);
  });

  // Switching sessions clears all virtual measurements and starts at the live edge.
  // TanStack keeps measurements by key, but a foreign transcript can reuse entry ids.
  useLayoutEffect(() => {
    followingRef.current = true;
    virtualizer.measure();
    // Measurement is deliberately batched by the virtualizer. Land once after the
    // first frame and once again after that batch has committed; otherwise a switch
    // can retain the previous scroll offset or land at the old estimated height.
    let settleFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      scrollToEnd();
      settleFrame = window.requestAnimationFrame(() => scrollToEnd());
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
    };
  }, [scrollToEnd, threadId, virtualizer]);

  // A streamed message can change before the virtualizer publishes a new size. Depend
  // on the transcript itself as well as its measurements, so a reader at the live edge
  // is moved on every flushed update instead of waiting for a ResizeObserver round.
  // Only a reader who was following the live edge is moved; history readers keep place.
  useLayoutEffect(() => {
    if (followingRef.current && turns.length > 0) scrollToEnd();
  }, [messages, scrollToEnd, totalSize, turns.length, virtualRows.length]);

  const virtualScrollController = useMemo(() => ({
    scrollToEnd,
    scrollToMessage,
    scrollToStart,
    start: scrollState.start,
    end: scrollState.end,
  }), [scrollState.end, scrollState.start, scrollToEnd, scrollToMessage, scrollToStart]);
  const reveal = useCallback((_messageId: string): boolean => false, []);

  // A remote transcript is on its way (loadingReplaces): cover the row on screen
  // rather than leaving the previous conversation visible while the fetch lands.
  if (loading && (messages.length === 0 || loadingReplaces)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <FLoader className="size-12" />
        <p className="text-sm text-muted-foreground">
          {loadingReplaces ? t("message.loadingConversation") : t("message.preparing")}
        </p>
      </div>
    );
  }

  if (messages.length === 0) {
    if (emptyState !== undefined) return emptyState ?? <div className="h-full" />;
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <NewSessionHero />
      </div>
    );
  }

  return (
    <MessageScrollerProvider autoScroll={false}>
      <VirtualMessageScrollerProvider value={virtualScrollController}>
        <MessageRevealProvider reveal={reveal}>
          <div ref={selectionRootRef} className="relative flex h-full min-h-0 flex-col">
            {/* Named container: the rail is only worth showing when the gutter beside the
                message column can hold it. */}
            <MessageScroller className="@container/thread">
              <MessageScrollerViewport ref={viewportCallback} className="scrollbar-thumb-scrollbar">
                <MessageScrollerContent className={CHAT_COLUMN_CLASS} style={{ overflowAnchor: "none" }}>
                  {/*
                   * The turns' own layer, inside the column rather than the column itself:
                   * an absolutely positioned box ignores its containing block's padding, so
                   * turns placed directly in the content spanned the column's `px-6` and
                   * sat flush against the window edge — on a phone, against the glass.
                   */}
                  <div className="relative" style={{ height: Math.max(totalSize, 1) }}>
                  {virtualRows.map((virtualRow) => {
                    const turn = turns[virtualRow.index];
                    if (!turn) return null;
                    return (
                      <div
                        key={virtualRow.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualRow.index}
                        className="absolute inset-x-0 pb-5"
                        // `top`, never `transform: translateY`. The turn's prompt is
                        // `position: sticky`, and sticky is resolved against layout
                        // positions, which a transform does not change: every turn laid
                        // out at `top: 0` read as starting at the top of the thread, so its
                        // prompt was pushed down by the whole scroll offset — leaving a
                        // gap where it belonged and landing on its own reply, the last
                        // turn's file chips and footer included.
                        style={{ top: virtualRow.start }}
                      >
                        <MessageGroup className="gap-5">
                          {turn.rows.map((row) => (
                            <ThreadRow
                              key={row.id}
                              row={row}
                              last={(rowIndex.get(row.id) ?? 0) === rows.length - 1}
                              streaming={streaming}
                              amendable={row.id === lastUserRowId}
                              onRetry={onRetry}
                              onEdit={onEdit}
                              onFork={onFork}
                              showThinking={showThinking}
                              showTimestamp={showTimestamp}
                              collapseRuns={collapseRuns}
                            />
                          ))}
                        </MessageGroup>
                      </div>
                    );
                  })}
                  </div>
                </MessageScrollerContent>
              </MessageScrollerViewport>
              {/* A single turn has nothing to navigate between. */}
              {markers.length > 1 ? <TurnRail markers={markers} rowIds={rowIds} /> : null}
              <MessageScrollerButton />
            </MessageScroller>
            <SelectionActionBar
              containerRef={selectionRootRef}
              onAddToConversation={onAddSelectionToConversation}
              onAskInSideChat={onAskSelectionInSideChat}
            />
            <FollowLatest messages={messages} />
          </div>
        </MessageRevealProvider>
      </VirtualMessageScrollerProvider>
    </MessageScrollerProvider>
  );
}
