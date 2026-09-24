import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, ArrowRight01Icon, Copy01Icon, GitForkIcon, PencilEdit02Icon, RotateCcwIcon, StopCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/time";
import { stripAttachmentBlock } from "@/lib/attachments";
import { i18n } from "@/lib/i18n";
import { groupParts, mergeAssistantRun, resolveParts, type RenderPart } from "@/lib/group-parts";
import { cn } from "@/lib/utils";
import type { ChatAttachment, ChatMessage, MessagePart } from "@shared/types";
import { ImagePreview } from "@/components/image-preview";
import { AttachmentChip } from "./attachment-chip";
import { collectChangedFiles, TurnFileChips } from "./file-chips";
import { MarkdownView } from "./markdown-view";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { ToolRow } from "./tool-row";
import { ToolGroupRow } from "./tool-group";
import { CompactNotice } from "./compact-notice";
import { ModelChangeNotice } from "./model-change-notice";
import { RunCollapse } from "./run-collapse";
import { TuiLines } from "./tui-lines";
import { isRemoteRef } from "@/lib/remote-project";
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
                        if (isRemoteRef(item.path) || blockedRemotely(Ipc.workspaceReveal)) return;
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
    // Revealed on hover — and simply shown on a touchscreen, which has no hover: an
    // invisible row of copy / edit / retry is still tappable, so a tap just below a
    // message could retry it from nothing on screen.
    <MessageFooter className="gap-1 px-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
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

/**
 * Why a reply ended early when nothing failed: it hit the model's output limit, or the
 * run was stopped. Quieter than the error bubble — neither is a failed request — but
 * never absent: both used to end the run with nothing on screen, which read as the
 * agent quitting on its own. A stop is named whoever caused it, because the transcript
 * cannot tell the user's 停止 from any other abort.
 */
function StopNotice({ reason }: { reason: NonNullable<ChatMessage["stop"]> }): JSX.Element {
  const { t } = useTranslation("chat");
  return (
    <div
      className={cn(
        "flex w-full max-w-2xl items-start gap-2 text-sm leading-5",
        reason === "length" ? "text-warning" : "text-muted-foreground",
      )}
    >
      <HugeiconsIcon
        strokeWidth={2}
        icon={reason === "length" ? AlertCircleIcon : StopCircleIcon}
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span className="min-w-0 wrap-break-word">
        {reason === "length" ? t("message.stoppedAtLength") : t("message.stoppedAborted")}
      </span>
    </div>
  );
}

/**
 * A transient provider failure is a tool-shaped status, not a terminal error. The
 * retry count stays visible in the summary; the provider's verbose response is kept
 * behind the same disclosure affordance as tool parameters and output.
 */
function RetryStatus({ message }: { message: ChatMessage }): JSX.Element | null {
  const { t } = useTranslation("common");
  const retry = message.retry;
  if (!retry) return null;
  const context = retry.maxAttempts
    ? t("errors.retryingAttempt", { attempt: retry.attempt, maxAttempts: retry.maxAttempts })
    : undefined;
  return (
    <ToolRow
      icon={<Spinner className="size-3" />}
      label={t("errors.retryingLabel")}
      context={context}
      running
      title={t("errors.retrying")}
      canToggle={Boolean(retry.error)}
      persistKey={`retry:${message.id}`}
    >
      {retry.error ? (
        <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{retry.error}</div>
      ) : null}
    </ToolRow>
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Entering the editor means "the user is being put into this draft", so the caret
  // belongs at the end of what is already there. A plain `autoFocus` focuses the
  // element before the controlled value lands, and the browser parks the caret at
  // offset 0 for that — the same trap the composer's focus effect documents.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  function submit(): void {
    const next = text.trim();
    if (next) onSubmit(next);
  }

  return (
    <div className="w-full max-w-2xl rounded-xl border border-border bg-secondary/50 p-2">
      <Textarea
        ref={textareaRef}
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

const MAX_VISIBLE_PROCESS_PARTS = 48;

function ProcessOverflow({
  count,
  children,
}: {
  count: number;
  children: JSX.Element[];
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-2xl">
      <CollapsibleTrigger
        className="group/process inline-flex items-center gap-1.5 rounded-none py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span>{open ? t("message.collapse") : t("message.expandProcess", { count })}</span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2.5 pt-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
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

  const processOverflow = useMemo(() => {
    if (isUser || fold || parts.length <= MAX_VISIBLE_PROCESS_PARTS) return null;
    const cutoff = Math.max(0, parts.length - MAX_VISIBLE_PROCESS_PARTS);
    const hidden = parts
      .map((part, index) => ({ part, index }))
      .filter(({ part, index }) => index < cutoff && (part.kind === "tool" || part.kind === "group" || (part.kind === "thinking" && showThinking)));
    return hidden.length > 0 ? { hidden, firstIndex: hidden[0].index } : null;
  }, [fold, isUser, parts, showThinking]);

  const plainPartEntries = useMemo(() => {
    if (!processOverflow) return parts.map((part, index) => ({ kind: "part" as const, part, index }));
    const hiddenIndexes = new Set(processOverflow.hidden.map(({ index }) => index));
    const entries: Array<
      | { kind: "part"; part: RenderPart; index: number }
      | { kind: "overflow"; hidden: Array<{ part: RenderPart; index: number }> }
    > = [];
    let inserted = false;
    parts.forEach((part, index) => {
      if (hiddenIndexes.has(index)) {
        if (!inserted && index === processOverflow.firstIndex) {
          entries.push({ kind: "overflow", hidden: processOverflow.hidden });
          inserted = true;
        }
        return;
      }
      entries.push({ kind: "part", part, index });
    });
    return entries;
  }, [parts, processOverflow]);

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

        {fold
          ? parts.slice(fold.cut).map((part, index) => renderPart(part, fold.cut + index))
          : plainPartEntries.map((entry) =>
              entry.kind === "overflow" ? (
                <ProcessOverflow key={`process-overflow-${entry.hidden[0].index}`} count={entry.hidden.length}>
                  {entry.hidden.map(({ part, index }) => renderPart(part, index)).filter((part): part is JSX.Element => part !== null)}
                </ProcessOverflow>
              ) : (
                renderPart(entry.part, entry.index)
              ),
            )}

        {message.retry ? <RetryStatus message={message} /> : null}
        {streaming && !message.error && !message.retry && !liveTail ? <WorkingStatus message={message} /> : null}

        {message.error && !message.retry ? (
          <Bubble variant="destructive" align="start">
            <BubbleContent className="flex items-start gap-2 text-sm leading-5">
              <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap wrap-break-word">{message.error}</span>
            </BubbleContent>
          </Bubble>
        ) : null}
        {message.stop && !message.error && !message.retry && !streaming ? <StopNotice reason={message.stop} /> : null}

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

export const ChatMessageRow = memo(ChatMessageRowImpl, (prev, next) => {
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

