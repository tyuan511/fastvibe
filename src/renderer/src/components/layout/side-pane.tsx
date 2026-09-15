import { useEffect, useMemo, useRef, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  BrowserIcon,
  Cancel01Icon,
  File01Icon,
  Folder01Icon,
  GitCompareIcon,
  GlobeIcon,
  MessageSquareIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/resize-handle";
import { MIN_WIDTH, useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import { releaseBrowser, SidePaneBrowser } from "./side-pane-browser";
import { SidePaneChat } from "./side-pane-chat";
import { SidePaneFiles } from "./side-pane-files";
import { SidePaneGit } from "./side-pane-git";
import { releaseTerminal, SidePaneTerminal } from "./side-pane-terminal";

function tabIcon(type: SidePaneTab["type"]) {
  if (type === "git") return GitCompareIcon;
  if (type === "terminal") return TerminalIcon;
  if (type === "browser") return GlobeIcon;
  if (type === "selection-side-chat") return MessageSquareIcon;
  if (type === "files") return Folder01Icon;
  return File01Icon;
}

export function SidePane({
  cwd,
  project,
  parentId,
  canSideChat,
  onError,
}: {
  cwd?: string;
  project?: string;
  parentId?: string;
  canSideChat: boolean;
  onError: (message: string) => void;
}): JSX.Element | null {
  const collapsed = useSidePaneStore((state) => state.collapsed);
  const width = useSidePaneStore((state) => state.width);
  const tabs = useSidePaneStore((state) => state.tabs);
  const activeTabId = useSidePaneStore((state) => state.activeTabId);
  const setWidth = useSidePaneStore((state) => state.setWidth);
  const setCollapsed = useSidePaneStore((state) => state.setCollapsed);
  const persistWidth = useSidePaneStore((state) => state.persistWidth);
  const activate = useSidePaneStore((state) => state.activate);
  const closeTab = useSidePaneStore((state) => state.close);
  const openGit = useSidePaneStore((state) => state.openGit);
  const openTerminal = useSidePaneStore((state) => state.openTerminal);
  const openBrowser = useSidePaneStore((state) => state.openBrowser);
  const openFiles = useSidePaneStore((state) => state.openFiles);
  const openSideChat = useSidePaneStore((state) => state.openSideChat);
  const nextSideChatOrdinal = useSidePaneStore((state) => state.nextSideChatOrdinal);
  const hasReviewTab = useSidePaneStore((state) => state.tabs.some((item) => item.type === "git"));
  const startWidth = useRef(width);
  // Set once the drag has crossed the minimum, so collapsing fires a single
  // store write instead of one per mousemove until the drag ends.
  const collapsing = useRef(false);

  const visibleTabs = useMemo(
    () => tabs.filter((item) => item.type !== "selection-side-chat" || (parentId && item.parentSessionId === parentId)),
    [parentId, tabs],
  );
  const active = useMemo(
    () => visibleTabs.find((item) => item.id === activeTabId) ?? visibleTabs.at(-1) ?? null,
    [visibleTabs, activeTabId],
  );

  useEffect(() => {
    if (activeTabId && visibleTabs.some((item) => item.id === activeTabId)) return;
    if (active) activate(active.id);
  }, [activate, active, activeTabId, visibleTabs]);

  function disposeTab(tab: SidePaneTab): void {
    if (tab.type === "terminal") releaseTerminal(tab.id);
    if (tab.type === "browser") releaseBrowser(tab.id);
    if (tab.type === "selection-side-chat" && tab.conversationId) {
      void window.fastvibe.conversations.delete(tab.conversationId).catch(() => undefined);
    }
  }

  function close(id: string): void {
    const tab = tabs.find((item) => item.id === id);
    if (tab) disposeTab(tab);
    closeTab(id);
  }

  function closeOthers(id: string): void {
    for (const tab of visibleTabs) {
      if (tab.id === id) continue;
      disposeTab(tab);
      closeTab(tab.id);
    }
  }

  function closeAll(): void {
    for (const tab of visibleTabs) {
      disposeTab(tab);
      closeTab(tab.id);
    }
  }

  if (collapsed) return null;

  const cards = [
    canSideChat && parentId
      ? {
          id: "selection-side-conversation",
          label: "辅助对话",
          icon: MessageSquareIcon,
          onOpen: () => openSideChat(parentId, nextSideChatOrdinal(parentId)),
        }
      : null,
    { id: "files", label: "文件", icon: Folder01Icon, onOpen: openFiles },
    hasReviewTab ? null : { id: "review", label: "审查", icon: GitCompareIcon, onOpen: openGit },
    { id: "terminal", label: "终端", icon: TerminalIcon, onOpen: () => openTerminal(cwd) },
    { id: "browser", label: "浏览器", icon: BrowserIcon, onOpen: () => openBrowser() },
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-border bg-background" style={{ width }}>
      <ResizeHandle
        side="left"
        onDragStart={() => {
          startWidth.current = width;
          collapsing.current = false;
        }}
        onDrag={(delta) => {
          const next = startWidth.current - delta;
          // Dragging past the minimum width collapses the pane instead of
          // clamping to it; the header toggle reopens it at the stored width.
          if (next < MIN_WIDTH) {
            if (!collapsing.current) {
              collapsing.current = true;
              setCollapsed(true);
            }
            return;
          }
          const max = Math.round(window.innerWidth * 0.65);
          setWidth(Math.min(max, next));
        }}
        onDragEnd={() => persistWidth()}
      />
      {visibleTabs.length > 0 ? (
        <div className="flex h-12 items-center gap-1 border-b border-border px-2">
          <div data-side-pane-tabs-viewport="" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {visibleTabs.map((tab) => (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger className="min-w-0">
                  <button
                    type="button"
                    data-side-pane-tab-id={tab.id}
                    className={cn(
                      "inline-flex h-7 max-w-40 min-w-15 flex-[1_1_9.75rem] items-center gap-1.5 overflow-hidden rounded-lg border border-transparent px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground hover:bg-muted",
                      tab.id === active?.id && "bg-muted text-foreground",
                    )}
                    onClick={() => activate(tab.id)}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        close(tab.id);
                      }
                    }}
                  >
                    <HugeiconsIcon strokeWidth={2} icon={tabIcon(tab.type)} className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
                    <span
                      role="presentation"
                      className="rounded-sm p-0.5 hover:bg-background"
                      onClick={(event) => {
                        event.stopPropagation();
                        close(tab.id);
                      }}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3" />
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => close(tab.id)}>关闭标签</ContextMenuItem>
                  <ContextMenuItem disabled={visibleTabs.length < 2} onClick={() => closeOthers(tab.id)}>
                    关闭其他标签
                  </ContextMenuItem>
                  <ContextMenuItem onClick={closeAll}>关闭所有标签</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-xs" variant="outline" aria-label="新增标签" />}>
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {canSideChat && parentId ? (
                <DropdownMenuItem onClick={() => openSideChat(parentId, nextSideChatOrdinal(parentId))}>
                  <HugeiconsIcon strokeWidth={2} icon={MessageSquareIcon} />
                  辅助对话
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={openFiles}>
                <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
                文件
              </DropdownMenuItem>
              {hasReviewTab ? null : (
                <DropdownMenuItem onClick={openGit}>
                  <HugeiconsIcon strokeWidth={2} icon={GitCompareIcon} />
                  审查
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => openTerminal(cwd)}>
                <HugeiconsIcon strokeWidth={2} icon={TerminalIcon} />
                终端
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openBrowser()}>
                <HugeiconsIcon strokeWidth={2} icon={GlobeIcon} />
                浏览器
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      {visibleTabs.length === 0 ? (
        <div className="side-pane-open-tab-shell flex min-h-0 flex-1 flex-col bg-background">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-10">
            <div className="side-pane-open-tab-content flex w-full max-w-[20rem] flex-col gap-5">
              <div className="flex flex-col gap-2 text-center">
                <h2 className="text-xl font-semibold leading-7 text-foreground">打开标签页</h2>
                <p className="text-sm leading-5 text-muted-foreground">选择要在侧边面板中打开的标签。</p>
              </div>
              <div className="side-pane-open-tab-list flex w-full flex-col gap-2">
                {cards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    data-side-pane-open-tab-item={card.id}
                    className="side-pane-open-tab-button flex h-12 min-w-0 items-center gap-3 rounded-xl bg-muted px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={card.onOpen}
                  >
                    <HugeiconsIcon strokeWidth={2} icon={card.icon} className="size-4 text-muted-foreground" />
                    <span className="side-pane-open-tab-button-label min-w-0 flex-1 truncate text-left">{card.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {active?.type === "git" ? <SidePaneGit cwd={cwd} onError={onError} /> : null}
          {active?.type === "selection-side-chat" && parentId ? (
            <SidePaneChat tab={active} project={project} parentId={parentId} />
          ) : null}
          {tabs.map((tab) =>
            tab.type === "terminal" || tab.type === "browser" || tab.type === "files" ? (
              <div key={tab.id} hidden={tab.id !== activeTabId} className="flex min-h-0 flex-1 flex-col">
                {tab.type === "terminal" ? (
                  <SidePaneTerminal tabId={tab.id} cwd={tab.cwd ?? cwd} sessionId={tab.sessionId} visible={tab.id === activeTabId} />
                ) : tab.type === "browser" ? (
                  <SidePaneBrowser tabId={tab.id} url={tab.url ?? "https://fastvibe.dev"} visible={tab.id === activeTabId} />
                ) : (
                  <SidePaneFiles tab={tab} cwd={cwd} onError={onError} />
                )}
              </div>
            ) : null,
          )}
        </div>
      )}
    </aside>
  );
}
