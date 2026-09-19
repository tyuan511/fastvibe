import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Copy01Icon, GitForkIcon, PencilEdit02Icon, RotateCcwIcon, Tick02Icon } from "@hugeicons/core-free-icons";
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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FindBar } from "@/components/chat/find-bar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/time";
import { stripAttachmentBlock } from "@/lib/attachments";
import { i18n } from "@/lib/i18n";
import { FLoader } from "@/components/f-loader";
import { groupMessageRows, groupParts, mergeAssistantRun, resolveParts, type MessageRow, type RenderPart } from "@/lib/group-parts";
import { cn } from "@/lib/utils";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-layout";
import type { ChatAttachment, ChatMessage, MessagePart } from "@shared/types";
import { ImagePreview } from "@/components/image-preview";
import { AttachmentChip } from "./attachment-chip";
import { collectChangedFiles, TurnFileChips } from "./file-chips";
import { MarkdownView } from "./markdown-view";
import { NewSessionHero } from "./new-session";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { ToolGroupRow } from "./tool-group";
import { CompactNotice } from "./compact-notice";
import { ModelChangeNotice } from "./model-change-notice";
import { RunCollapse } from "./run-collapse";
import { TuiLines } from "./tui-lines";
import { TurnRail, type TurnMarker } from "./turn-rail";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";

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
                    ? () => {
                        if (blockedRemotely(Ipc.workspaceReveal)) return;
                        void window.fastvibe.workspace.reveal(item.path!);
                      }
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
  forkEntryId,
  onFork,
  onRetry,
  onEdit,
  showTimestamp,
  elapsed,
}: {
  message: ChatMessage;
  /** Last persisted assistant entry in a visually merged run; never its `running:` row. */
  forkEntryId?: string;
  onFork?: (entryId: string) => void;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showTimestamp: boolean;
  /** The whole turn's span, when the footer is the one reporting it. */
  elapsed?: number;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  // A reply's footer reports when it *finished* and how long the whole turn took; the engine
  // only stores the request start, so the end comes from Main's entry timing and a reply still
  // streaming (or one read back from before that timing existed) falls back to the start time
  // alone. That total is a different number from the fold header's 用时, which measures only the
  // work the fold hides — so both are shown, and they read in the same spoken form so the two
  // are comparable at a glance.
  const ended = message.completedAt ?? message.createdAt;
  return (
    <MessageFooter className="gap-1 px-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
      {showTimestamp ? (
        <span className="tabular-nums">
          {formatTime(ended)}
          {elapsed !== undefined && elapsed > 0 ? (
            <span className="text-muted-foreground/60"> · {t("message.elapsed", { duration: formatDuration(elapsed) })}</span>
          ) : null}
        </span>
      ) : null}
      {message.text ? (
        <ActionButton
          label={t("message.copy")}
          onClick={() => {
            void navigator.clipboard.writeText(stripAttachmentBlock(message.text));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1000);
          }}
        >
          {copied ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} className="size-3.5" />}
        </ActionButton>
      ) : null}
      {message.role === "user" && onEdit ? (
        <ActionButton label={t("message.edit")} onClick={() => onEdit(message)}>
          <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-3.5" />
        </ActionButton>
      ) : null}
      {message.role === "assistant" && forkEntryId && onFork ? (
        <ActionButton label={t("message.fork")} onClick={() => onFork(forkEntryId)}>
          <HugeiconsIcon strokeWidth={2} icon={GitForkIcon} className="size-3.5" />
        </ActionButton>
      ) : null}
      {onRetry ? (
        <ActionButton label={t("message.retry")} onClick={() => onRetry(message)}>
          <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} className="size-3.5" />
        </ActionButton>
      ) : null}
    </MessageFooter>
  );
}

function WorkingStatus({ message }: { message: ChatMessage }): JSX.Element {
  const { t } = useTranslation("chat");
  // The run is between tool calls or about to write, so this row is the only thing
  // in the reply. It stays in the same inline icon + shimmering-label shape as the
  // thinking block and tool rows — a chip here would be the one bordered box in a
  // transcript of quiet rows — but at the reading size and the emphasis shade, so
  // "still working" is legible where a line of 12.5px grey was not.
  return (
    <div className="flex items-center gap-2 text-sm">
      <Spinner className="size-4 text-muted-foreground" />
      <span className="animated-gradient-text animated-gradient-text-emphasis font-medium">
        {message.tools.length > 0 ? t("message.workingOn") : t("message.working")}
      </span>
    </div>
  );
}

/** Inline tool rows are grouped, but still share the assistant column's width cap. */
function PartSlot({ children }: { children: JSX.Element }): JSX.Element {
  return <div className="flex w-full max-w-2xl flex-col">{children}</div>;
}

/**
 * User prompts clamp to two lines so a sticky turn header stays compact. The
 * expand control only appears when the prompt actually overflows that cap.
 */
function UserPromptBubble({ text: raw }: { text: string }): JSX.Element {
  const { t } = useTranslation("chat");
  // A prompt that brought files along carries their paths as a model-facing block.
  // The chips above the bubble are how the reader sees those attachments, so the
  // block never reaches the bubble — the engine's copy keeps it, and stripping it
  // here is what makes the live row and a re-read transcript agree.
  const text = stripAttachmentBlock(raw);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [text]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;

    const measure = (): void => {
      if (expanded) {
        const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
        const cap = (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24) * 2;
        setOverflows(node.scrollHeight > cap + 1);
        return;
      }
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <Bubble variant="secondary" align="end">
      <BubbleContent className="chat-markdown text-sm leading-6">
        <div ref={bodyRef} className={expanded ? undefined : "line-clamp-2"}>
          <MarkdownView text={text} />
        </div>
        {overflows ? (
          <button
            type="button"
            className="mt-1 text-xs leading-4 text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t("message.collapse") : t("message.expand")}
          </button>
        ) : null}
      </BubbleContent>
    </Bubble>
  );
}

/** Edit a prompt in its turn. The transcript is left untouched until Send is pressed. */
function InlinePromptEditor({
  value,
  onCancel,
  onSubmit,
}: {
  value: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [text, setText] = useState(value);

  function submit(): void {
    const next = text.trim();
    if (next) onSubmit(next);
  }

  return (
    <div className="w-full max-w-2xl rounded-xl border border-border bg-secondary/50 p-2">
      <Textarea
        autoFocus
        rows={2}
        value={text}
        aria-label={t("message.editPlaceholder")}
        placeholder={t("message.editPlaceholder")}
        className="h-16 min-h-16 resize-none [field-sizing:fixed] border-0 bg-transparent shadow-none focus-visible:ring-0"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("message.editCancel")}
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={submit}>
          {t("message.editSend")}
        </Button>
      </div>
    </div>
  );
}

function ChatMessageRowImpl({
  messages,
  streaming,
  onRetry,
  onEdit,
  onFork,
  showThinking,
  showTimestamp,
  collapseRuns,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => void;
  onFork?: (entryId: string) => void;
  showThinking: boolean;
  showTimestamp: boolean;
  collapseRuns: boolean;
}): JSX.Element {
  // A reply spans several engine messages; render it as one block with one footer.
  const message = useMemo(() => mergeAssistantRun(messages), [messages]);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [message.id]);
  const isUser = message.role === "user";
  // A live snapshot appends `running:<id>` to the persisted round-trips in this
  // visual run. Fork only from the last real SDK entry, never that display row.
  const forkEntryId = useMemo(() => {
    if (message.role !== "assistant") return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate.role === "assistant" && !candidate.id.startsWith("running:")) return candidate.id;
    }
    return undefined;
  }, [message.role, messages]);
  const beginEdit = useCallback(() => setEditing(true), []);
  const submitEdit = useCallback(
    (text: string) => {
      setEditing(false);
      onEdit?.(message, text);
    },
    [message, onEdit],
  );
  // `i18n.language` is part of the dependency list because the folded group summaries
  // are translated and cached per language: without it a language switch would keep
  // serving the previous language's summaries.
  const parts = useMemo(() => groupParts(message), [message, i18n.language]);

  // 折叠运行过程: a finished run's work — thinking, tool calls, and the prose it wrote along
  // the way — goes behind one collapsed 「用时 …」 row, and the reply written after the last
  // tool call stays out as the answer.
  //
  // Decided only once the run is over, and only when it produced both halves: something to
  // hide and an answer to leave on screen. A run still in flight, one that stopped on a tool
  // call, and a failed one all draw the plain transcript instead — a 「用时」 row that cannot
  // be collapsed, sitting over content the reader is watching, reads as broken (zcode gates
  // its fold the same way, off the turn's terminal state).
  //
  // The split is anchored on where the last process part ended, not on 「the last text」:
  // which prose will turn out to be the answer cannot be known while it streams, but where
  // the last tool call ended is already on screen.

  // The run's own span: the first round-trip's request start to the instant its last entry was
  // persisted. This is the turn's total, and it is what the footer reports as 耗时.
  const runMs =
    message.completedAt === undefined
      ? undefined
      : Math.max(0, message.completedAt - message.createdAt);

  // What the fold hides took until the reply's *final* message began — the work before the
  // answer, since the answer's own generation is not part of the process the fold stands for.
  // That makes 用时 and the footer's 耗时 two different numbers, which is the point of having
  // both. An engine message is one model request, so its request start is where the previous
  // work — every tool call the turn made — had finished. A run that produced everything in a
  // single request has no such boundary to measure, so it falls back to that request's span.
  const workMs = useMemo(() => {
    if (runMs === undefined) return undefined;
    if (messages.length <= 1) return runMs;
    const split = Math.max(0, messages[messages.length - 1].createdAt - message.createdAt);
    return split > 0 ? split : runMs;
  }, [message.createdAt, messages, runMs]);

  // A thinking block's measured bounds are the only record of how long it thought, and they can
  // legitimately be missing — a transcript from a build that did not time them, a delegated
  // run's, an imported one. Fall back to the span of the round-trip the block came from, so the
  // row still reports a time instead of a bare 「思考」. The number is then that whole request's,
  // an upper bound rather than the thought alone, which is why the measured bounds win.
  const thinkingOwner = useMemo(() => {
    const owners = new Map<MessagePart, ChatMessage>();
    for (const item of messages) {
      if (item.role !== "assistant") continue;
      for (const part of resolveParts(item)) if (part.kind === "thinking") owners.set(part, item);
    }
    return owners;
  }, [messages]);

  const fold = useMemo(() => {
    if (!collapseRuns || message.role !== "assistant") return null;
    if (streaming || message.error) return null;
    // No measured end (a transcript written before Main timed entries) means no 用时.
    if (workMs === undefined) return null;
    let cut = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const kind = parts[index].kind;
      if (kind === "thinking" || kind === "tool" || kind === "group") cut = index + 1;
    }
    // Nothing to put in the block (a reply that never thought or called a tool).
    if (cut === 0) return null;
    // A body that would render nothing (only hidden thinking) is an empty box.
    if (!parts.slice(0, cut).some((part) => part.kind !== "thinking" || showThinking)) return null;
    // No prose after the last tool call: the run wrote no answer, so there is nothing to
    // leave on screen and folding would hide its only output.
    if (!parts.slice(cut).some((part) => part.kind === "text")) return null;
    return { cut, durationMs: workMs };
  }, [collapseRuns, message.error, message.role, parts, showThinking, streaming, workMs]);

  // A leading 「模型已切换至 …」 divider stays outside the fold. It says which model the
  // reply came from — the one fact about the run that is not process — and burying it
  // behind a collapsed 「用时 …」 after the run settles loses it exactly when the reader
  // is scrolling back through finished turns to find it.
  const foldHead = useMemo(() => {
    if (!fold) return 0;
    let index = 0;
    while (index < fold.cut && parts[index]?.kind === "model") index += 1;
    return index;
  }, [fold, parts]);

  // Files this agent run wrote, surfaced as a chip row under the reply.
  const changedFiles = useMemo(
    () => (isUser ? [] : collectChangedFiles(message.tools)),
    [isUser, message.tools],
  );

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

  // Outside the `renderPart` closure: it is a fact about the reply, not about one
  // part, and the row's working marker below is the only consumer.
  //
  // Whether the tail of the reply already says "still going". A tool call in flight
  // carries its own spinner, an open thinking block shimmers 「正在思考」, and a
  // trailing text part blinks the caret — so when one of those is on screen the row
  // would just be a second, redundant marker. Everything else — the wait after a
  // tool returns, before its result is fed back and the model writes its next
  // token — has no live element at all, and the settled tool cards above read as a
  // hang. The gate is the *tail*, not "the reply has no text yet": once a run has
  // written a sentence, every later tool→model boundary was silent.
  //
  // The tool check is over the whole reply, not just the last part, because a run of
  // sibling tools renders as one `group` part whose summary row shimmers on its own
  // — the spinner lives inside the folded children, so the part alone cannot say.
  const lastPart = parts.at(-1);
  const liveTail =
    lastPart?.kind === "text" ||
    (showThinking && lastPart?.kind === "thinking") ||
    message.tools.some((tool) => tool.status === "running");
  if (isUser && editing) {
    return (
      <Message align="end" className="group/row">
        <MessageContent className="items-end">
          {message.attachments?.length ? <AttachmentStrip items={message.attachments} /> : null}
          <InlinePromptEditor
            value={stripAttachmentBlock(message.text)}
            onCancel={() => setEditing(false)}
            onSubmit={submitEdit}
          />
        </MessageContent>
      </Message>
    );
  }

  const renderPart = (part: RenderPart, index: number): JSX.Element | null => {
    const isTail = index === parts.length - 1;
    if (part.kind === "thinking") {
      if (!showThinking) return null;
      const owner = thinkingOwner.get(part);
      const fallback =
        owner && owner.completedAt !== undefined
          ? { startedAt: owner.createdAt, endedAt: owner.completedAt }
          : undefined;
      return (
        <PartSlot key={`thinking-${index}`}>
          <ThinkingBlock
            thinking={part.text}
            startedAt={part.startedAt ?? fallback?.startedAt}
            endedAt={part.endedAt ?? fallback?.endedAt}
            active={streaming && isTail}
          />
        </PartSlot>
      );
    }
    if (part.kind === "text") {
      if (isUser) {
        return <UserPromptBubble key={`text-${index}`} text={part.text} />;
      }
      return (
        <Bubble key={`text-${index}`} variant="ghost" align="start">
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
    if (part.kind === "model") {
      // A transcript-level rule, so it spans the column instead of the reply's cap.
      return <ModelChangeNotice key={`model-${index}`} to={part.to} />;
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

        {foldHead > 0 ? parts.slice(0, foldHead).map((part, index) => renderPart(part, index)) : null}

        {fold && foldHead < fold.cut ? (
          <RunCollapse durationMs={fold.durationMs}>
            {parts.slice(foldHead, fold.cut).map((part, index) => renderPart(part, foldHead + index))}
          </RunCollapse>
        ) : null}

        {(fold ? parts.slice(fold.cut) : parts).map((part, index) =>
          renderPart(part, fold ? fold.cut + index : index),
        )}

        {streaming && !message.error && !liveTail ? <WorkingStatus message={message} /> : null}

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
            forkEntryId={forkEntryId}
            onFork={onFork}
            onRetry={onRetry}
            onEdit={onEdit ? beginEdit : undefined}
            showTimestamp={showTimestamp}
            elapsed={runMs}
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
    prev.collapseRuns === next.collapseRuns &&
    prev.onRetry === next.onRetry &&
    prev.onEdit === next.onEdit &&
    prev.onFork === next.onFork &&
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
      prompt: clip(stripAttachmentBlock(row.messages[0].text), PROMPT_LIMIT),
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
      className={isUser ? "relative sticky top-0 z-10 bg-background pt-2 [content-visibility:visible]" : undefined}
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

export function MessageList({
  messages,
  streaming,
  loading = false,
  onRetry,
  onEdit,
  onFork,
  showThinking = true,
  showTimestamp = true,
  collapseRuns = false,
  emptyState,
  findOpen = false,
  onCloseFind,
  findQuery,
  onFindQueryConsumed,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => void;
  /** Omit in read-only/secondary panes so their transcripts cannot fork the main catalog. */
  onFork?: (entryId: string) => void;
  showThinking?: boolean;
  showTimestamp?: boolean;
  /** Fold each reply's process into one 「用时 …」 block (设置 → 对话). */
  collapseRuns?: boolean;
  emptyState?: JSX.Element | null;
  /** 在会话中查找 is open (the thread's own find bar). */
  findOpen?: boolean;
  onCloseFind?: () => void;
  /** Query the find bar opens with, from a palette body-search hit. */
  findQuery?: string | null;
  onFindQueryConsumed?: () => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
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
        <p className="text-sm text-muted-foreground">{t("message.preparing")}</p>
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
      <div className="flex h-full min-h-0 flex-col">
        <FindBar
          messages={messages}
          open={findOpen}
          onClose={() => onCloseFind?.()}
          initialQuery={findQuery ?? undefined}
          onInitialQueryConsumed={onFindQueryConsumed}
        />
      {/* Named container: the rail is only worth showing when the gutter beside the
          message column can hold it. */}
      <MessageScroller className="@container/thread">
        <MessageScrollerViewport ref={guardViewport} className="scrollbar-thumb-scrollbar">
          <MessageScrollerContent className={cn(CHAT_COLUMN_CLASS, "py-6")}>
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
                    onFork={onFork}
                    showThinking={showThinking}
                    showTimestamp={showTimestamp}
                    collapseRuns={collapseRuns}
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
      </div>
    </MessageScrollerProvider>
  );
}
