import { useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, PencilIcon, RotateCcwIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageFooter, MessageGroup } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { groupMessageRows, groupParts, mergeAssistantRun, type RenderPart } from "@/lib/group-parts";
import type { ChatAttachment, ChatMessage } from "@shared/types";
import { MarkdownView } from "./markdown-view";
import { NewSessionHero } from "./new-session";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { ToolGroupRow } from "./tool-group";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AttachmentStrip({ items }: { items: ChatAttachment[] }): JSX.Element {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {items.map((item) =>
        item.kind === "image" && item.dataUrl ? (
          <img key={item.id} src={item.dataUrl} alt={item.name} className="max-h-36 rounded-lg border border-border" />
        ) : (
          <button
            key={item.id}
            type="button"
            className="rounded-md border border-border bg-background px-2 py-1 text-[11px]"
            onClick={() => item.path && void window.fastvibe.workspace.reveal(item.path)}
          >
            {item.name}
          </button>
        ),
      )}
    </div>
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
  visible,
}: {
  message: ChatMessage;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showTimestamp: boolean;
  visible: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <MessageFooter
      className={cn(
        "gap-1 px-0 transition-opacity",
        visible ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100",
      )}
    >
      {showTimestamp ? <span className="tabular-nums">{formatTime(message.createdAt)}</span> : null}
      {message.text ? (
        <>
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
          {message.role === "user" && onEdit ? (
            <ActionButton label="编辑" onClick={() => onEdit(message)}>
              <HugeiconsIcon strokeWidth={2} icon={PencilIcon} className="size-3.5" />
            </ActionButton>
          ) : null}
          {onRetry ? (
            <ActionButton label="重试" onClick={() => onRetry(message)}>
              <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} className="size-3.5" />
            </ActionButton>
          ) : null}
        </>
      ) : null}
    </MessageFooter>
  );
}

function WorkingStatus({ message }: { message: ChatMessage }): JSX.Element | null {
  const running = message.tools.find((tool) => tool.status === "running");
  if (running) return null;
  if (message.thinking) return null;
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      <Spinner className="size-3.5" />
      {message.tools.length > 0 ? "继续工作" : "正在工作"}
    </div>
  );
}

/** Inline tool rows are grouped, but still share the assistant column's width cap. */
function PartSlot({ children }: { children: JSX.Element }): JSX.Element {
  return <div className="flex w-full max-w-2xl flex-col">{children}</div>;
}

function ChatMessageRow({
  messages,
  streaming,
  last,
  onRetry,
  onEdit,
  showThinking,
  showTimestamp,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  last: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showThinking: boolean;
  showTimestamp: boolean;
}): JSX.Element {
  // A reply spans several engine messages; render it as one block with one footer.
  const message = useMemo(() => mergeAssistantRun(messages), [messages]);
  const parts = useMemo(() => groupParts(message), [message]);

  if (message.role === "system") {
    return (
      <div className="flex justify-center py-1">
        <Bubble variant={message.kind === "goal" ? "secondary" : "muted"} align="start">
          <BubbleContent className="chat-markdown text-[12px]">
            {message.kind === "goal" ? "目标 · " : message.kind === "compact" ? "压缩 · " : ""}
            {message.text}
          </BubbleContent>
        </Bubble>
      </div>
    );
  }

  const isUser = message.role === "user";
  const hasText = parts.some((part) => part.kind === "text" && part.text);

  const renderPart = (part: RenderPart, index: number): JSX.Element | null => {
    const isTail = index === parts.length - 1;
    if (part.kind === "thinking") {
      if (!showThinking) return null;
      return (
        <PartSlot key={`thinking-${index}`}>
          <ThinkingBlock thinking={part.text} active={streaming && isTail} />
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
          <BubbleContent className="chat-markdown text-[13.5px] leading-6">
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

        {streaming && !hasText ? <WorkingStatus message={message} /> : null}

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
            visible={last}
          />
        )}
      </MessageContent>
    </Message>
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

  if (messages.length === 0 && loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="size-4" />
        <p className="text-[13px]">正在准备工作区…</p>
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
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport className="scrollbar-thumb-scrollbar">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl px-6 py-6">
            <MessageGroup className="gap-5">
              {rows.map((row, index) => (
                <MessageScrollerItem
                  key={row.id}
                  id={row.id}
                  scrollAnchor={index === rows.length - 1}
                >
                  <ChatMessageRow
                    messages={row.messages}
                    streaming={streaming && index === rows.length - 1 && row.messages[0].role === "assistant"}
                    last={index === rows.length - 1}
                    onRetry={onRetry}
                    onEdit={onEdit}
                    showThinking={showThinking}
                    showTimestamp={showTimestamp}
                  />
                </MessageScrollerItem>
              ))}
            </MessageGroup>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
