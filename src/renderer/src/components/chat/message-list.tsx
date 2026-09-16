import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Copy01Icon, PencilEdit02Icon, RotateCcwIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageFooter, MessageGroup } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FLoader } from "@/components/f-loader";
import { groupMessageRows, groupParts, mergeAssistantRun, type MessageRow, type RenderPart } from "@/lib/group-parts";
import type { ChatAttachment, ChatMessage } from "@shared/types";
import { ImagePreview } from "@/components/image-preview";
import { AttachmentChip } from "./attachment-chip";
import { collectChangedFiles, TurnFileChips } from "./file-chips";
import { MarkdownView } from "./markdown-view";
import { NewSessionHero } from "./new-session";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { ToolGroupRow } from "./tool-group";
import { CompactNotice } from "./compact-notice";
import { TuiLines } from "./tui-lines";
import { TurnRail, type TurnMarker } from "./turn-rail";

function formatTime(timestamp: number): string {
  // 24-hour clock in the reader's own time zone; `h23` avoids locales that render
  // midnight as 24:00 under a bare `hour12: false`.
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function AttachmentStrip({ items }: { items: ChatAttachment[] }): JSX.Element {
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  const previewSrc = preview?.dataUrl ?? "";

  return (
    <>
      <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
        {items.map((item) => {
          const previewable = item.kind === "image" && Boolean(item.dataUrl);
          return (
            <AttachmentChip
              key={item.id}
              item={item}
              className={previewable ? "cursor-zoom-in" : undefined}
              onOpen={
                previewable
                  ? () => setPreview(item)
                  : item.path
                    ? () => void window.fastvibe.workspace.reveal(item.path!)
                    : undefined
              }
            />
          );
        })}
      </div>
      <ImagePreview
        src={previewSrc}
        alt={preview?.name}
        open={Boolean(previewSrc)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      />
    </>
  );
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function MessageActions({
  message,
  onRetry,
  onEdit,
  showTimestamp,
}: {
  message: ChatMessage;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showTimestamp: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <MessageFooter className="gap-1 px-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
      {showTimestamp ? <span className="tabular-nums">{formatTime(message.createdAt)}</span> : null}
      {message.text ? (
        <ActionButton
          label="复制"
          onClick={() => {
            void navigator.clipboard.writeText(message.text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1000);
          }}
        >
          {copied ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} className="size-3.5" />}
        </ActionButton>
      ) : null}
      {message.role === "user" && onEdit ? (
        <ActionButton label="编辑" onClick={() => onEdit(message)}>
          <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-3.5" />
        </ActionButton>
      ) : null}
      {onRetry ? (
        <ActionButton label="重试" onClick={() => onRetry(message)}>
          <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} className="size-3.5" />
        </ActionButton>
      ) : null}
    </MessageFooter>
  );
}

function WorkingStatus({ message }: { message: ChatMessage }): JSX.Element | null {
  const running = message.tools.find((tool) => tool.status === "running");
  if (running) return null;
  if (message.thinking) return null;
  // The run is between tool calls or about to write, so this row is the only thing
  // in the reply. It stays in the same inline icon + shimmering-label shape as the
  // thinking block and tool rows — a chip here would be the one bordered box in a
  // transcript of quiet rows — but at the reading size and the emphasis shade, so
  // "still working" is legible where a line of 12.5px grey was not.
  return (
    <div className="flex items-center gap-2 text-sm">
      <Spinner className="size-4 text-muted-foreground" />
      <span className="animated-gradient-text animated-gradient-text-emphasis font-medium">
        {message.tools.length > 0 ? "继续工作" : "正在工作"}
      </span>
    </div>
  );
}

/** Inline tool rows are grouped, but still share the assistant column's width cap. */
function PartSlot({ children }: { children: JSX.Element }): JSX.Element {
  return <div className="flex w-full max-w-2xl flex-col">{children}</div>;
}

function ChatMessageRowImpl({
  messages,
  streaming,
  onRetry,
  onEdit,
  showThinking,
  showTimestamp,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showThinking: boolean;
  showTimestamp: boolean;
}): JSX.Element {
  // A reply spans several engine messages; render it as one block with one footer.
  const message = useMemo(() => mergeAssistantRun(messages), [messages]);
  const parts = useMemo(() => groupParts(message), [message]);

  if (message.role === "system") {
    if (message.kind === "compact") {
      return (
        <div className="flex w-full max-w-2xl flex-col py-1">
          <CompactNotice message={message} />
        </div>
      );
    }
    // An extension custom message: the plugin's own renderer produced these runs.
    if (message.kind === "custom" && message.runs && message.runs.length > 0) {
      return (
        <div className="flex justify-center py-1">
          <div className="w-full max-w-3xl overflow-x-auto rounded-xl border border-border bg-card px-3 py-2">
            <TuiLines runs={message.runs} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-center py-1">
        <Bubble variant="muted" align="start">
          <BubbleContent className="chat-markdown text-xs">{message.text}</BubbleContent>
        </Bubble>
      </div>
    );
  }

  const isUser = message.role === "user";
  const hasText = parts.some((part) => part.kind === "text" && part.text);
  // Files this agent run wrote, surfaced as a chip row under the reply.
  const changedFiles = useMemo(
    () => (isUser ? [] : collectChangedFiles(message.tools)),
    [isUser, message.tools],
  );

  const renderPart = (part: RenderPart, index: number): JSX.Element | null => {
    const isTail = index === parts.length - 1;
    if (part.kind === "thinking") {
      if (!showThinking) return null;
      return (
        <PartSlot key={`thinking-${index}`}>
          <ThinkingBlock
            thinking={part.text}
            startedAt={part.startedAt}
            endedAt={part.endedAt}
            active={streaming && isTail}
          />
        </PartSlot>
      );
    }
    if (part.kind === "text") {
      return (
        <Bubble
          key={`text-${index}`}
          variant={isUser ? "secondary" : "ghost"}
          align={isUser ? "end" : "start"}
        >
          <BubbleContent className="chat-markdown text-sm leading-6">
            <MarkdownView text={part.text} />
            {streaming && isTail ? <span className="chat-caret" aria-hidden /> : null}
          </BubbleContent>
        </Bubble>
      );
    }
    if (part.kind === "tool") {
      return (
        <PartSlot key={`tool-${part.tool.id}`}>
          <ToolCard tool={part.tool} />
        </PartSlot>
      );
    }
    return (
      <PartSlot key={part.group.id}>
        <ToolGroupRow group={part.group} />
      </PartSlot>
    );
  };

  return (
    <Message align={isUser ? "end" : "start"} className="group/row">
      <MessageContent className={isUser ? "items-end" : "items-start"}>
        {message.attachments?.length ? <AttachmentStrip items={message.attachments} /> : null}

        {parts.map(renderPart)}

        {streaming && !hasText && !message.error ? <WorkingStatus message={message} /> : null}

        {message.error ? (
          <Bubble variant="destructive" align="start">
            <BubbleContent className="flex items-start gap-2 text-sm leading-5">
              <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap wrap-break-word">{message.error}</span>
            </BubbleContent>
          </Bubble>
        ) : null}

        {/*
         * Withhold the turn's file chips until the run ends. Mid-run they grow as
         * each write/edit lands, reflowing the thread and showing a half-finished
         * change set.
         */}
        {!streaming && changedFiles.length > 0 ? (
          <div className="w-full max-w-2xl pt-1">
            <TurnFileChips files={changedFiles} />
          </div>
        ) : null}

        {/*
         * Withhold the toolbar while this row is streaming. It used to stay mounted
         * at `opacity-0` for the hover reveal, so it kept reserving ~20px and its
         * hover state kept flipping as the growing content reflowed under the
         * pointer — which read as constant flicker. The actions are also useless
         * mid-run: retry only makes sense once a reply has finished, and copy would
         * capture a half-written answer.
         */}
        {streaming ? null : (
          <MessageActions
            message={message}
            onRetry={onRetry}
            onEdit={onEdit}
            showTimestamp={showTimestamp}
          />
        )}
      </MessageContent>
    </Message>
  );
}

/**
 * A row only changes when the engine clones one of its messages (the one being
 * streamed into). Compare the message list by identity so finished rows skip
 * re-rendering entirely on each streamed token; the handlers are semantically
 * stable, so their per-render identity is intentionally ignored.
 */
function sameMessages(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

const ChatMessageRow = memo(ChatMessageRowImpl, (prev, next) => {
  return (
    prev.streaming === next.streaming &&
    prev.showThinking === next.showThinking &&
    prev.showTimestamp === next.showTimestamp &&
    prev.onRetry === next.onRetry &&
    prev.onEdit === next.onEdit &&
    sameMessages(prev.messages, next.messages)
  );
});

const PROMPT_LIMIT = 140;
const REPLY_LIMIT = 180;

/** Collapse to a single line and clip, so a mark's preview always fits its card. */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
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
      prompt: clip(row.messages[0].text, PROMPT_LIMIT),
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

    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const top = node.getBoundingClientRect().top;
      const edge = scroller.getBoundingClientRect().top;
      const next =
        Math.abs(top - edge) <= PIN_SLACK && top > turn.getBoundingClientRect().top + PIN_SLACK;
      setPinned((current) => (current === next ? current : next));
    };
    // One read per frame: every row hears the scroll, measure once.
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    scroller.addEventListener("scroll", schedule, { passive: true });
    // The turn also moves with no scroll event of its own: content streaming into an
    // earlier turn grows the scroller's content, and a resize moves the top edge.
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) observer.observe(content);
    schedule();

    detach.current = () => {
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
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
  showThinking,
  showTimestamp,
}: {
  row: MessageRow;
  last: boolean;
  streaming: boolean;
  amendable: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showThinking: boolean;
  showTimestamp: boolean;
}): JSX.Element {
  const isUser = row.messages[0].role === "user";
  const { ref, pinned } = usePinnedPrompt();

  return (
    <MessageScrollerItem
      ref={isUser ? ref : undefined}
      id={row.id}
      messageId={row.id}
      className={isUser ? "relative sticky top-0 z-10 bg-background pt-2 [content-visibility:visible]" : undefined}
    >
      <ChatMessageRow
        messages={row.messages}
        streaming={streaming && last && !isUser}
        onRetry={amendable ? onRetry : undefined}
        onEdit={amendable ? onEdit : undefined}
        showThinking={showThinking}
        showTimestamp={showTimestamp}
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

export function MessageList({
  messages,
  streaming,
  loading = false,
  onRetry,
  onEdit,
  showThinking = true,
  showTimestamp = true,
  emptyState,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showThinking?: boolean;
  showTimestamp?: boolean;
  emptyState?: JSX.Element | null;
}): JSX.Element {
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

  if (messages.length === 0 && loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <FLoader className="size-12" />
        <p className="text-sm text-muted-foreground">正在准备工作区…</p>
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
    <MessageScrollerProvider autoScroll>
      {/* Named container: the rail is only worth showing when the gutter beside the
          message column can hold it. */}
      <MessageScroller className="@container/thread">
        <MessageScrollerViewport ref={guardViewport} className="scrollbar-thumb-scrollbar">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl px-6 py-6">
            {turns.map((turn) => (
              <MessageGroup key={turn.id} className="gap-5">
                {turn.rows.map((row) => (
                  <ThreadRow
                    key={row.id}
                    row={row}
                    last={(rowIndex.get(row.id) ?? 0) === rows.length - 1}
                    streaming={streaming}
                    amendable={row.id === lastUserRowId}
                    onRetry={onRetry}
                    onEdit={onEdit}
                    showThinking={showThinking}
                    showTimestamp={showTimestamp}
                  />
                ))}
              </MessageGroup>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* A single turn has nothing to navigate between. */}
        {markers.length > 1 ? <TurnRail markers={markers} rowIds={rowIds} /> : null}
        <MessageScrollerButton />
      </MessageScroller>
      <FollowLatest messages={messages} />
    </MessageScrollerProvider>
  );
}
