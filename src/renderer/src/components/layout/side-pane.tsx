import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowExpand02Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  ChromeIcon,
  File01Icon,
  Folder01Icon,
  GitCompareIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  TerminalIcon,
  BotIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
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
import { CollapsiblePanel } from "@/components/layout/collapsible-panel";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { useSettingsStore } from "@/stores/settings";
import { MIN_WIDTH, useSidePaneStore, type SidePaneTab, sidePaneTabTitle } from "@/stores/side-pane";
import { releaseBrowser, SidePaneBrowser } from "./side-pane-browser";
import { SidePaneChat } from "./side-pane-chat";
import { SidePaneFiles } from "./side-pane-files";
import { SidePaneGit } from "./side-pane-git";
import { SidePaneSubagent } from "./side-pane-subagent";
import { releaseTerminal, SidePaneTerminal } from "./side-pane-terminal";
import { HAS_CUSTOM_TITLE_BAR, IS_MAC } from "@/lib/platform";

/**
 * Release everything a set of pane tabs owns. Called when tabs are closed and when
 * a whole conversation's pane state is dropped (chat deleted or archived), so a
 * shell or browser view never outlives the tab that showed it.
 */
export function disposeSidePaneTabs(tabs: SidePaneTab[]): void {
  for (const tab of tabs) {
    if (tab.type === "terminal") releaseTerminal(tab.id);
    if (tab.type === "browser") releaseBrowser(tab.id);
    if (tab.type === "selection-side-chat" && tab.conversationId) {
      void window.fastvibe.conversations.delete(tab.conversationId).catch(() => undefined);
    }
  }
}

function CollapseButton(): JSX.Element {
  const { t } = useTranslation("sidepane");
  const setCollapsed = useSidePaneStore((state) => state.setCollapsed);
  const shortcut = useShortcutLabel("toggleSidePane");
  return (
    <IconButton
      size="icon-sm"
      variant="ghost"
      className="no-drag shrink-0 text-muted-foreground"
      label={t("pane.collapse")}
      shortcut={shortcut}
      onClick={() => setCollapsed(true)}
    >
      <HugeiconsIcon strokeWidth={2} icon={PanelRightCloseIcon} />
    </IconButton>
  );
}

function SidebarCollapsedChrome({ onNewChat }: { onNewChat: () => void }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const updateSettings = useSettingsStore((state) => state.update);
  const toggleSidebarShortcut = useShortcutLabel("toggleSidebar");
  const newChatShortcut = useShortcutLabel("newChat");
  return (
    <div className="no-drag flex shrink-0 items-center gap-1">
      {/* With a title bar of its own the sidebar's toggle is up there, on screen at
          the same time as this row — one control, one place. */}
      {HAS_CUSTOM_TITLE_BAR ? null : (
        <IconButton
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground"
          label={t("pane.expandSidebar")}
          shortcut={toggleSidebarShortcut}
          onClick={() => updateSettings({ sidebarCollapsed: false })}
        >
          <HugeiconsIcon strokeWidth={2} icon={PanelLeftOpenIcon} />
        </IconButton>
      )}
      <IconButton
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground"
        label={t("pane.newChat")}
        shortcut={newChatShortcut}
        onClick={onNewChat}
      >
        <HugeiconsIcon strokeWidth={2} icon={MessageSquarePlusIcon} />
      </IconButton>
      <span className="mx-1.5 h-4 w-px shrink-0 bg-border" aria-hidden />
    </div>
  );
}

function MaximizeButton(): JSX.Element {
  const { t } = useTranslation("sidepane");
  const maximized = useSidePaneStore((state) => state.maximized);
  const toggleMaximized = useSidePaneStore((state) => state.toggleMaximized);
  return (
    <IconButton
      size="icon-sm"
      variant="ghost"
      className="no-drag shrink-0 text-muted-foreground"
      label={maximized ? t("pane.restore") : t("pane.maximize")}
      onClick={toggleMaximized}
    >
      <HugeiconsIcon strokeWidth={2} icon={maximized ? ArrowShrink01Icon : ArrowExpand02Icon} />
    </IconButton>
  );
}

function tabIcon(type: SidePaneTab["type"]) {
  if (type === "subagent") return BotIcon;
  if (type === "git") return GitCompareIcon;
  if (type === "terminal") return TerminalIcon;
  if (type === "browser") return ChromeIcon;
  if (type === "selection-side-chat") return MessageSquareIcon;
  if (type === "files") return Folder01Icon;
  return File01Icon;
}

function BrowserTabIcon({ src }: { src?: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        className="size-3.5 shrink-0 rounded-sm"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return <HugeiconsIcon strokeWidth={2} icon={ChromeIcon} className="size-3.5 shrink-0" />;
}

export function SidePane({
  cwd,
  project,
  parentId,
  canSideChat,
  onNewChat,
  onError,
}: {
  cwd?: string;
  project?: string;
  parentId?: string;
  canSideChat: boolean;
  onNewChat: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const collapsed = useSidePaneStore((state) => state.collapsed);
  const maximized = useSidePaneStore((state) => state.maximized);
  const sidebarCollapsed = useSettingsStore((state) => state.settings.sidebarCollapsed ?? false);
  const width = useSidePaneStore((state) => state.width);
  const leadWithSidebarChrome = maximized && sidebarCollapsed;
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
  const tabsViewportRef = useRef<HTMLDivElement>(null);
  // Live splitter drags skip the spring so the edge tracks the pointer.
  const [resizing, setResizing] = useState(false);

  const visibleTabs = useMemo(
    () =>
      tabs.filter((item) => {
        // Aux chats and delegated runs belong to the chat on screen: a parent's
        // tab bar must not list another conversation's subagents.
        if (item.type === "selection-side-chat") return Boolean(parentId && item.parentSessionId === parentId);
        if (item.type === "subagent") return !parentId || item.subagentConversationId === parentId;
        return true;
      }),
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

  useEffect(() => {
    if (!active?.id) return;
    const viewport = tabsViewportRef.current;
    const tab = viewport?.querySelector(`[data-side-pane-tab-id="${CSS.escape(active.id)}"]`);
    if (!viewport || !(tab instanceof HTMLElement)) return;
    const tabRect = tab.getBoundingClientRect();
    const viewRect = viewport.getBoundingClientRect();
    if (tabRect.left < viewRect.left) viewport.scrollLeft += tabRect.left - viewRect.left;
    else if (tabRect.right > viewRect.right) viewport.scrollLeft += tabRect.right - viewRect.right;
  }, [active?.id]);

  function close(id: string): void {
    const tab = tabs.find((item) => item.id === id);
    if (tab) disposeSidePaneTabs([tab]);
    closeTab(id);
    if (visibleTabs.filter((item) => item.id !== id).length === 0) setCollapsed(true);
  }

  function closeOthers(id: string): void {
    disposeSidePaneTabs(visibleTabs.filter((item) => item.id !== id));
    for (const tab of visibleTabs) {
      if (tab.id === id) continue;
      closeTab(tab.id);
    }
  }

  function closeAll(): void {
    disposeSidePaneTabs(visibleTabs);
    for (const tab of visibleTabs) {
      closeTab(tab.id);
    }
    setCollapsed(true);
  }

  const cards = [
    canSideChat && parentId
      ? {
          id: "selection-side-conversation",
          label: t("pane.sideChat"),
          icon: MessageSquareIcon,
          onOpen: () => openSideChat(parentId, nextSideChatOrdinal(parentId)),
        }
      : null,
    { id: "files", label: t("pane.files"), icon: Folder01Icon, onOpen: openFiles },
    hasReviewTab ? null : { id: "review", label: t("pane.review"), icon: GitCompareIcon, onOpen: openGit },
    { id: "terminal", label: t("pane.terminal"), icon: TerminalIcon, onOpen: () => openTerminal(cwd) },
    { id: "browser", label: t("pane.browser"), icon: ChromeIcon, onOpen: () => openBrowser() },
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <CollapsiblePanel collapsed={collapsed} width={width} side="right" instant={resizing} maximized={maximized}>
    <aside
      className={cn(
        "relative flex h-full min-h-0 w-full flex-col bg-background",
        // Maximized, the conversation column is gone and this pane sits against
        // the sidebar — keep only the sidebar's trailing border, not both.
        !maximized && "border-l border-border",
      )}
    >
      {maximized ? null : (
      <ResizeHandle
        side="left"
        onDragStart={() => {
          startWidth.current = width;
          collapsing.current = false;
          setResizing(true);
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
        onDragEnd={() => {
          setResizing(false);
          persistWidth();
        }}
      />
      )}
      {visibleTabs.length > 0 ? (
        <div
          className={cn(
            "flex h-11 shrink-0 items-center gap-1 overflow-hidden border-b border-border px-2",
            leadWithSidebarChrome && IS_MAC && "pl-22",
          )}
        >
          {leadWithSidebarChrome ? <SidebarCollapsedChrome onNewChat={onNewChat} /> : null}
          <div className="flex min-w-0 flex-1 items-center gap-1">
          <div
            ref={tabsViewportRef}
            data-side-pane-tabs-viewport=""
            className="no-scrollbar flex h-7 min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-fade-x"
            onWheel={(event) => {
              const node = event.currentTarget;
              if (node.scrollWidth <= node.clientWidth) return;
              if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
              node.scrollLeft += event.deltaY;
            }}
          >
            {visibleTabs.map((tab) => (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger className="min-w-0 shrink-0">
                  <button
                    type="button"
                    data-side-pane-tab-id={tab.id}
                    className={cn(
                      "inline-flex h-7 max-w-40 min-w-15 items-center gap-1.5 overflow-hidden rounded-lg border border-transparent px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground hover:bg-muted",
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
                    {tab.type === "browser" ? (
                      <BrowserTabIcon src={tab.faviconUrl} />
                    ) : (
                      <HugeiconsIcon strokeWidth={2} icon={tabIcon(tab.type)} className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-left">
                      {sidePaneTabTitle(tab)}
                    </span>
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
                  <ContextMenuItem onClick={() => close(tab.id)}>{t("pane.closeTab")}</ContextMenuItem>
                  <ContextMenuItem disabled={visibleTabs.length < 2} onClick={() => closeOthers(tab.id)}>
                    {t("pane.closeOthers")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={closeAll}>{t("pane.closeAll")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-xs" variant="outline" className="shrink-0" aria-label={t("pane.newTab")} />}>
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {canSideChat && parentId ? (
                <DropdownMenuItem onClick={() => openSideChat(parentId, nextSideChatOrdinal(parentId))}>
                  <HugeiconsIcon strokeWidth={2} icon={MessageSquareIcon} />
                  {t("pane.sideChat")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={openFiles}>
                <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
                {t("pane.files")}
              </DropdownMenuItem>
              {hasReviewTab ? null : (
                <DropdownMenuItem onClick={openGit}>
                  <HugeiconsIcon strokeWidth={2} icon={GitCompareIcon} />
                  {t("pane.review")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => openTerminal(cwd)}>
                <HugeiconsIcon strokeWidth={2} icon={TerminalIcon} />
                {t("pane.terminal")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openBrowser()}>
                <HugeiconsIcon strokeWidth={2} icon={ChromeIcon} />
                {t("pane.browser")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
          <MaximizeButton />
          <CollapseButton />
        </div>
      ) : (
        <div
          className={cn(
            "drag-region flex h-11 shrink-0 items-center gap-0.5 px-2",
            leadWithSidebarChrome ? "justify-between" : "justify-end",
            leadWithSidebarChrome && IS_MAC && "pl-22",
          )}
        >
          {leadWithSidebarChrome ? <SidebarCollapsedChrome onNewChat={onNewChat} /> : null}
          <div className="flex items-center gap-0.5">
            <MaximizeButton />
            <CollapseButton />
          </div>
        </div>
      )}
      {visibleTabs.length === 0 ? (
        <div className="side-pane-open-tab-shell flex min-h-0 flex-1 flex-col bg-background">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-10">
            <div className="side-pane-open-tab-content flex w-full max-w-[20rem] flex-col gap-5">
              <div className="flex flex-col gap-2 text-center">
                <h2 className="text-xl font-semibold leading-7 text-foreground">{t("pane.openTabs")}</h2>
                <p className="text-sm leading-5 text-muted-foreground">{t("pane.openTabsDesc")}</p>
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
          {visibleTabs.map((tab) =>
            tab.type === "terminal" || tab.type === "browser" || tab.type === "files" || tab.type === "subagent" ? (
              <div key={tab.id} hidden={tab.id !== activeTabId} className="flex min-h-0 flex-1 flex-col">
                {tab.type === "terminal" ? (
                  <SidePaneTerminal tabId={tab.id} cwd={tab.cwd ?? cwd} sessionId={tab.sessionId} visible={tab.id === activeTabId} />
                ) : tab.type === "browser" ? (
                  <SidePaneBrowser tabId={tab.id} url={tab.url ?? ""} visible={tab.id === activeTabId} />
                ) : (
                  tab.type === "files" ? <SidePaneFiles tab={tab} cwd={cwd} onError={onError} /> : <SidePaneSubagent tab={tab} />
                )}
              </div>
            ) : null,
          )}
        </div>
      )}
    </aside>
    </CollapsiblePanel>
  );
}
