import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem,
  MessageScrollerProvider, MessageScrollerViewport, VirtualMessageScrollerProvider,
} from "@/components/ui/message-scroller";
import { SelectionActionBar } from "@/components/chat/selection-action-bar";
import { TranscriptConversationContext } from "@/components/chat/conversation-context";
import { Spinner } from "@/components/ui/spinner";
import { WorkspacePathContext } from "@/lib/workspace-path-context";
import { formatViviMessageTime, viviMessageLayout } from "@/lib/vivi-message-layout";
import { activeLanguage } from "@/lib/i18n";
import { localeTag } from "@/lib/language";
import { cn } from "@/lib/utils";
import { ViviMessageRow } from "./vivi-message-row";
import type { FastVibeMascotPalette } from "@/components/fastvibe-mascot";
import type { ChatMessage } from "@shared/types";

/** IM history is virtualized by message, independently of Agent turns and sticky prompts. */
export const ViviMessageList = memo(function ViviMessageList({ messages, conversationId, palette, loading, emptyState, footer }: {
  messages: ChatMessage[];
  conversationId: string;
  palette: FastVibeMascotPalette;
  loading?: boolean;
  emptyState: JSX.Element;
  footer?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation("app");
  const locale = localeTag(activeLanguage());
  const rows = useMemo(() => viviMessageLayout(messages), [messages]);
  // Today/yesterday are calendar labels. One midnight timer updates them even in an idle chat.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 100);
    const timer = window.setTimeout(() => setNow(Date.now()), midnight.getTime() - Date.now());
    return () => window.clearTimeout(timer);
  }, [now]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const scrolling = useRef(false);
  const scrollFrame = useRef(0);
  const [edges, setEdges] = useState({ start: false, end: true });
  const threadKey = `${conversationId}:${messages[0]?.id ?? "empty"}`;
  const [landed, setLanded] = useState<string | null>(null);
  const landing = landed !== threadKey;
  const rangeExtractor = useCallback((range: Range) => {
    // Measure only the live edge on open, rather than parsing the start then discarding it.
    if (!landing) return defaultRangeExtractor(range);
    const count = Math.max(12, Math.ceil((viewportRef.current?.clientHeight ?? window.innerHeight) / 64));
    return Array.from({ length: Math.min(count, range.count) }, (_, i) => Math.max(0, range.count - count) + i);
  }, [landing]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => `${conversationId}:${rows[index].message.id}`,
    estimateSize: () => 100,
    overscan: 4,
    rangeExtractor,
    useFlushSync: false,
    paddingStart: 16,
    paddingEnd: 20,
  });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const syncEdges = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const next = { start: node.scrollTop > 8, end: node.scrollHeight - node.scrollTop - node.clientHeight <= 8 };
    setEdges((current) => current.start === next.start && current.end === next.end ? current : next);
    if (next.end) setLanded(threadKey);
  }, [threadKey]);
  const scrollToEnd = useCallback((): boolean => {
    const node = viewportRef.current;
    if (!node) return false;
    following.current = true;
    scrolling.current = true;
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    syncEdges();
    window.cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = window.requestAnimationFrame(() => { scrolling.current = false; syncEdges(); });
    return true;
  }, [syncEdges]);
  const scrollToStart = useCallback((): boolean => {
    if (!viewportRef.current) return false;
    following.current = false;
    setLanded(threadKey);
    viewportRef.current.scrollTop = 0;
    syncEdges();
    return true;
  }, [syncEdges, threadKey]);
  const scrollToMessage = useCallback((id: string): boolean => {
    const index = rows.findIndex((row) => row.message.id === id);
    if (index < 0 || !viewportRef.current) return false;
    following.current = false;
    setLanded(threadKey);
    virtualizer.scrollToIndex(index, { align: "start" });
    return true;
  }, [rows, threadKey, virtualizer]);
  const controller = useMemo(() => ({ ...edges, scrollToEnd, scrollToStart, scrollToMessage }), [edges, scrollToEnd, scrollToStart, scrollToMessage]);
  const lastUserId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === "user") return messages[index].id;
    return null;
  }, [messages]);
  const previousUser = useRef(lastUserId);

  useLayoutEffect(() => {
    following.current = true;
    virtualizer.measure();
    previousUser.current = lastUserId;
  }, [threadKey, virtualizer]);
  useLayoutEffect(() => {
    if (lastUserId !== previousUser.current) following.current = true;
    previousUser.current = lastUserId;
    if (following.current && rows.length) scrollToEnd();
  }, [footer, lastUserId, messages, rows.length, scrollToEnd, totalSize]);
  // Width/font changes and asynchronously decoded attachments can alter measured heights.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToEnd();
      else syncEdges();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, messages.length > 0, scrollToEnd, syncEdges]);
  useEffect(() => () => window.cancelAnimationFrame(scrollFrame.current), []);

  if (loading && !messages.length) return <div className="flex h-full items-center justify-center"><Spinner aria-label={t("viviBot.chat.loading")} /></div>;
  if (!messages.length) return emptyState;

  return (
    <TranscriptConversationContext.Provider value={conversationId}>
      <WorkspacePathContext.Provider value={null}>
        <MessageScrollerProvider defaultScrollPosition="start" autoScroll={false}>
          <VirtualMessageScrollerProvider value={controller}>
            <div ref={selectionRef} className="relative h-full min-h-0" data-slot="vivi-message-list">
              <MessageScroller>
                <MessageScrollerViewport
                  ref={viewportRef}
                  aria-label={t("viviBot.chat.messages")}
                  className="overflow-x-hidden"
                  style={{ overflowAnchor: "none" }}
                  onScroll={() => {
                    const node = viewportRef.current;
                    if (node && !scrolling.current) following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
                    syncEdges();
                  }}
                  onWheel={(event) => {
                    if (event.deltaY < 0) { following.current = false; setLanded(threadKey); }
                  }}
                  onTouchMove={() => { following.current = false; setLanded(threadKey); }}
                  onKeyDown={(event) => {
                    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) { following.current = false; setLanded(threadKey); }
                  }}
                >
                  <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-0 px-4 sm:px-6">
                    <div className="relative shrink-0" style={{ height: Math.max(1, totalSize) }}>
                      {items.map((item) => {
                        const row = rows[item.index];
                        const date = new Date(row.message.createdAt);
                        const validTime = Number.isFinite(date.getTime());
                        return (
                          <MessageScrollerItem
                            key={item.key}
                            ref={virtualizer.measureElement}
                            data-index={item.index}
                            messageId={row.message.id}
                            className={cn("absolute inset-x-0 [content-visibility:visible]", row.groupStart ? "pt-4" : "pt-1.5")}
                            style={{ top: item.start }}
                          >
                            {row.showTime && validTime ? (
                              <div className="pb-5 pt-1 text-center">
                                <time data-slot="vivi-time-separator" dateTime={date.toISOString()} className="text-xs tabular-nums text-muted-foreground">
                                  {formatViviMessageTime(row.message.createdAt, locale, now, row.showDay)}
                                </time>
                              </div>
                            ) : null}
                            <ViviMessageRow
                              message={row.message} groupStart={row.groupStart} palette={palette}
                              timestamp={validTime ? date.toLocaleString(locale) : ""}
                            />
                          </MessageScrollerItem>
                        );
                      })}
                    </div>
                    {footer ? <div className="pb-3 pl-10.5">{footer}</div> : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton><HugeiconsIcon icon={ArrowDown02Icon} strokeWidth={2} /><span className="sr-only">{t("viviBot.chat.latest")}</span></MessageScrollerButton>
              </MessageScroller>
              <SelectionActionBar containerRef={selectionRef} />
            </div>
          </VirtualMessageScrollerProvider>
        </MessageScrollerProvider>
      </WorkspacePathContext.Provider>
    </TranscriptConversationContext.Provider>
  );
});
