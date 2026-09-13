import { useState, type JSX } from "react";
import { Bug, Check, Compass, Copy, Pencil, RotateCcw, ShieldCheck, Wand2 } from "lucide-react";
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
import type { ChatAttachment, ChatMessage } from "@shared/types";
import { MarkdownView } from "./markdown-view";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";

const SUGGESTIONS: Array<{ icon: JSX.Element; label: string; prompt: string }> = [
  {
    icon: <Compass />,
    label: "探索并理解代码",
    prompt: "请探索这个项目，说明它的结构、主要模块和它们之间的关系。",
  },
  {
    icon: <Wand2 />,
    label: "构建新功能、应用或工具",
    prompt: "帮我构建一个新功能：",
  },
  {
    icon: <ShieldCheck />,
    label: "审查代码并提出修改建议",
    prompt: "请审查最近的代码改动，指出问题和改进建议。",
  },
  {
    icon: <Bug />,
    label: "修复问题和失败",
    prompt: "帮我定位并修复这个问题：",
  },
];

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
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </ActionButton>
          {message.role === "user" && onEdit ? (
            <ActionButton label="编辑" onClick={() => onEdit(message)}>
              <Pencil className="size-3.5" />
            </ActionButton>
          ) : null}
          {onRetry ? (
            <ActionButton label="重试" onClick={() => onRetry(message)}>
              <RotateCcw className="size-3.5" />
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

function ChatMessageRow({
  message,
  streaming,
  last,
  onRetry,
  onEdit,
  showThinking,
  showTimestamp,
}: {
  message: ChatMessage;
  streaming: boolean;
  last: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showThinking: boolean;
  showTimestamp: boolean;
}): JSX.Element {
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
  const thinkingActive = Boolean(streaming && message.thinking && !message.text && message.tools.length === 0);

  return (
    <Message align={isUser ? "end" : "start"} className="group/row">
      <MessageContent className={isUser ? "items-end" : "items-start"}>
        {message.attachments?.length ? <AttachmentStrip items={message.attachments} /> : null}

        {message.thinking && showThinking ? (
          <ThinkingBlock thinking={message.thinking} active={thinkingActive} />
        ) : null}

        {message.tools.length > 0 ? (
          <div className="flex w-full max-w-2xl flex-col gap-1">
            {message.tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : null}

        {message.text ? (
          <Bubble variant={isUser ? "secondary" : "ghost"} align={isUser ? "end" : "start"}>
            <BubbleContent className="chat-markdown text-[13.5px] leading-6">
              <MarkdownView text={message.text} />
              {streaming ? <span className="chat-caret" aria-hidden /> : null}
            </BubbleContent>
          </Bubble>
        ) : streaming ? (
          <WorkingStatus message={message} />
        ) : null}

        <MessageActions
          message={message}
          onRetry={onRetry}
          onEdit={onEdit}
          showTimestamp={showTimestamp}
          visible={last && !streaming}
        />
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
  onSuggestion,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showThinking?: boolean;
  showTimestamp?: boolean;
  onSuggestion?: (prompt: string) => void;
}): JSX.Element {
  if (messages.length === 0 && loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="size-4" />
        <p className="text-[13px]">正在准备工作区…</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-8 px-6">
        <div className="flex flex-col items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
            <svg viewBox="0 0 24 24" fill="none" className="size-6 text-muted-foreground" aria-hidden>
              <rect x="4" y="6" width="16" height="13" rx="4" stroke="currentColor" strokeWidth="1.6" />
              <path d="M9 21v-2M15 21v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="9.5" cy="12.5" r="1.1" fill="currentColor" />
              <circle cx="14.5" cy="12.5" r="1.1" fill="currentColor" />
            </svg>
          </div>
          <h2 className="text-[26px] font-semibold tracking-tight">我们要构建什么？</h2>
        </div>
        <div className="grid w-full max-w-3xl grid-cols-2 gap-3 lg:grid-cols-4">
          {SUGGESTIONS.map((item) => (
            <button
              key={item.label}
              type="button"
              className={cn(
                "flex h-28 flex-col justify-between rounded-xl border border-border bg-card p-3.5 text-left",
                "transition-colors hover:bg-muted/50",
              )}
              onClick={() => onSuggestion?.(item.prompt)}
            >
              <span className="text-muted-foreground [&_svg]:size-4">{item.icon}</span>
              <span className="text-[12.5px] leading-5 text-foreground">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl px-6 py-6">
            <MessageGroup className="gap-5">
              {messages.map((message, index) => (
                <MessageScrollerItem
                  key={message.id}
                  id={message.id}
                  scrollAnchor={index === messages.length - 1}
                >
                  <ChatMessageRow
                    message={message}
                    streaming={
                      streaming && index === messages.length - 1 && message.role === "assistant"
                    }
                    last={index === messages.length - 1}
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
