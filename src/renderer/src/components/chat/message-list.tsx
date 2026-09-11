import { useState, type JSX } from "react";
import { Bug, Check, Compass, Copy, Pencil, RotateCcw, ShieldCheck, Wand2 } from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Message, MessageContent, MessageGroup } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatAttachment, ChatMessage } from "@shared/types";
import { MarkdownView } from "./markdown-view";
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
    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {showTimestamp ? <span className="tabular-nums">{formatTime(message.createdAt)}</span> : null}
      {message.text ? (
        <>
          <button
            type="button"
            className="opacity-0 transition-opacity group-hover/row:opacity-100"
            onClick={() => {
              void navigator.clipboard.writeText(message.text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1000);
            }}
            aria-label="复制"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          {message.role === "user" && onEdit ? (
            <button
              type="button"
              className="opacity-0 transition-opacity group-hover/row:opacity-100"
              onClick={() => onEdit(message)}
              aria-label="编辑"
            >
              <Pencil className="size-3.5" />
            </button>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              className="opacity-0 transition-opacity group-hover/row:opacity-100"
              onClick={() => onRetry(message)}
              aria-label="重试"
            >
              <RotateCcw className="size-3.5" />
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ChatMessageRow({
  message,
  streaming,
  onRetry,
  onEdit,
  showThinking,
  showTimestamp,
}: {
  message: ChatMessage;
  streaming: boolean;
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

  return (
    <Message align={isUser ? "end" : "start"} className="group/row">
      <MessageContent className={isUser ? "items-end" : "items-start"}>
        {message.attachments?.length ? <AttachmentStrip items={message.attachments} /> : null}

        {message.thinking && showThinking ? (
          <Collapsible>
            <CollapsibleTrigger className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
              思考过程
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 max-w-2xl rounded-lg border border-border bg-muted/40 p-2.5 whitespace-pre-wrap text-[11.5px] leading-5 text-muted-foreground">
              {message.thinking}
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {message.tools.length > 0 ? (
          <div className="flex w-full max-w-2xl flex-col gap-1">
            {message.tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : null}

        {message.text ? (
          <Bubble variant={isUser ? "default" : "ghost"} align={isUser ? "end" : "start"}>
            <BubbleContent className="chat-markdown text-[13.5px] leading-6">
              <MarkdownView text={message.text} />
              {streaming ? <Spinner className="ml-1 inline size-3" /> : null}
            </BubbleContent>
          </Bubble>
        ) : streaming ? (
          <Spinner />
        ) : null}

        <MessageActions
          message={message}
          onRetry={onRetry}
          onEdit={onEdit}
          showTimestamp={showTimestamp}
        />
      </MessageContent>
    </Message>
  );
}

export function MessageList({
  messages,
  streaming,
  onRetry,
  onEdit,
  showThinking = true,
  showTimestamp = true,
  onSuggestion,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  onRetry?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  showThinking?: boolean;
  showTimestamp?: boolean;
  onSuggestion?: (prompt: string) => void;
}): JSX.Element {
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
