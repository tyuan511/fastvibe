import { memo, useCallback, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Alert02Icon, AlertCircleIcon, Archive04Icon, ArrowLeft01Icon, ArrowRight01Icon, Delete02Icon, Folder01Icon, Folder02Icon, FolderRootIcon, Link01Icon, MessageSquarePlusIcon, MoreHorizontalIcon, PanelLeftCloseIcon, PencilEdit02Icon, PinIcon, PuzzleIcon, Search01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove } from "@dnd-kit/sortable";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { IconButton } from "@/components/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizablePanel } from "@/components/ui/resizable";
import { CollapsiblePanel } from "@/components/layout/collapsible-panel";
import { setSidebarCollapsed, useIsNarrowViewport, useSidebarCollapsed } from "@/lib/sidebar-visibility";
import { SidebarUpdateButton } from "@/components/layout/sidebar-update-button";
import { AppLogo } from "@/components/app-logo";
import { cn } from "@/lib/utils";
import { readSidebarWidth, writeSidebarWidth, SIDEBAR_MIN_WIDTH } from "@/lib/sidebar-width";
import { HAS_CUSTOM_TITLE_BAR, HAS_TRAFFIC_LIGHTS } from "@/lib/platform";
import { useArchivedIds } from "@/stores/archive";
import { useSettingsStore } from "@/stores/settings";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { useSidePanel } from "@/lib/use-resizable-panel";
import { useHistoryNav } from "@/lib/use-history-nav";
import type { Conversation, Project } from "@shared/types";
import {
  COLLAPSED_KEY,
  PROJECT_SESSION_LIMIT,
  PROJECTS_SECTION,
  type RenameTarget,
  type DeleteTarget,
  type ActiveDrag,
  DROP_ANIMATION,
  type DragSection,
  type DropIndicator,
  readIdSet,
  readPinned,
  persistPinned,
  SectionLabel,
  DropLine,
  DraggableProject,
  applyManualOrder,
  sectionKey,
  LiftedSessionRow,
  LiftedProjectRow,
  DraggableSession,
} from "./sidebar-rows";

export const Sidebar = memo(function Sidebar({
  projects,
  conversations,
  activeId,
  running,
  waitingForUser,
  failedInBackground,
  onNewChat,
  onOpen,
  onFork,
  onArchive,
  onAddProject,
  onAddRemoteProject,
  onRenameSession,
  onRenameProject,
  onRemoveProject,
  onRevealProject,
  onReorderProjects,
  onOpenSettings,
  onOpenMarket,
  onSearch,
}: {
  projects: Project[];
  conversations: Conversation[];
  activeId: string | null;
  running: Record<string, boolean>;
  /** Chats parked on a blocking prompt (a tool approval, an agent question). */
  waitingForUser: Record<string, boolean>;
  /** Chats whose run ended abnormally while another one was on screen. */
  failedInBackground: Record<string, boolean>;
  onNewChat: (cwd?: string) => void;
  onOpen: (id: string) => void;
  /** Copies a settled chat at its current tip and opens the new conversation. */
  onFork: (id: string) => void;
  /** Hides the chat from every list; the shell also closes it when it is on screen. */
  onArchive: (id: string) => void;
  onAddProject: () => void;
  onAddRemoteProject: () => void;
  onRenameSession: (id: string, title: string) => void;
  onRenameProject: (cwd: string, name: string) => void;
  onRemoveProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  /** Persists a drag-reordered project list; the catalog owns the order. */
  onReorderProjects: (cwds: string[]) => void;
  onOpenSettings: () => void;
  onOpenMarket: () => void;
  onSearch: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const [width] = useState(readSidebarWidth);
  const sidebarCollapsed = useSidebarCollapsed();
  const narrow = useIsNarrowViewport();
  const sidebarOrder = useSettingsStore((state) => state.settings.sidebarOrder);
  const updateSettings = useSettingsStore((state) => state.update);
  const toggleSidebarShortcut = useShortcutLabel("toggleSidebar");
  const { canBack, canForward, back, forward } = useHistoryNav();
  const searchShortcut = useShortcutLabel("commandPalette");
  // Which projects are folded, and which show every chat rather than the first few.
  // Both live in settings.json so they survive a restart (and the dev/packaged
  // localStorage split); the legacy localStorage fold list is promoted once.
  const collapsedList = useSettingsStore((state) => state.settings.sidebarCollapsedProjects);
  const expandedList = useSettingsStore((state) => state.settings.sidebarExpandedProjects);
  const collapsed = useMemo(() => new Set(collapsedList ?? readIdSet(COLLAPSED_KEY)), [collapsedList]);
  const expandedProjects = useMemo(() => new Set(expandedList ?? []), [expandedList]);
  const [pinned, setPinned] = useState<Record<string, number>>(() => readPinned());
  // Shared with Settings → 归档对话, where archived chats can be restored or deleted.
  const archived = useArchivedIds();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [drop, setDrop] = useState<DropIndicator | null>(null);
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  // dnd-kit may clear `event.over` while it is tearing down the drag. Keep the last
  // computed position so a valid drop is not mistaken for a cancel and snapped back.
  const lastDrop = useRef<DropIndicator | null>(null);
  const sidebarPanel = useSidePanel({
    id: "sidebar",
    width,
    collapsed: sidebarCollapsed,
    minSize: SIDEBAR_MIN_WIDTH,
    // The same ceiling `clampSidebarWidth` applies to the stored value, expressed
    // as a share of the shell so it keeps its meaning when the window is resized.
    maxSize: "40%",
    persist: writeSidebarWidth,
    reportCollapsed: setSidebarCollapsed,
  });
  // A small threshold keeps a plain click (open the chat) from starting a drag,
  // and lets the row's nested pin/archive buttons stop propagation untouched.
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  // No reordering in the phone drawer: a thumb scrolling the list is a pointer moving
  // more than 5px over a row, so every scroll that began on a chat picked it up.
  const sensors = useSensors(...(narrow ? [] : [pointerSensor]));

  /**
   * The drawer covers the whole screen, so whatever a tap in it asked for — a chat,
   * a new one, settings — happens behind it. Closing it is part of the action there;
   * the desktop column stays exactly as it was.
   */
  function dismissDrawer(): void {
    if (narrow) setSidebarCollapsed(true);
  }

  function setOpen(cwd: string, open: boolean): void {
    const next = new Set(collapsed);
    if (open) next.delete(cwd);
    else next.add(cwd);
    updateSettings({ sidebarCollapsedProjects: [...next] });
  }

  function togglePinned(id: string): void {
    setPinned((prev) => {
      const next = { ...prev };
      if (id in next) delete next[id];
      else next[id] = Date.now();
      persistPinned(next);
      return next;
    });
  }

  function sortSessions(items: Conversation[]): Conversation[] {
    // Creation order, not activity order: opening or renaming a chat must not
    // make it jump to the top of the list.
    return [...items].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  const pinnedItems = useMemo(() => {
    const items = conversations.filter(
      (item) => item.preview && pinned[item.id] !== undefined && !archived.has(item.id),
    );
    const sorted = [...items].sort(
      (a, b) => (pinned[b.id] ?? 0) - (pinned[a.id] ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
    return applyManualOrder(sorted, sidebarOrder?.[sectionKey("pinned")]);
  }, [conversations, pinned, archived, sidebarOrder]);

  const groups = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    for (const item of conversations) {
      if (!item.project || !item.preview) continue;
      // Pinned chats live in the dedicated "已置顶" area, archived ones are hidden.
      if (pinned[item.id] !== undefined || archived.has(item.id)) continue;
      const list = byProject.get(item.project) ?? [];
      list.push(item);
      byProject.set(item.project, list);
    }

    const result: Array<{ project: Project; cwd: string; name: string; items: Conversation[]; key: string }> = [];
    for (const project of projects) {
      const items = byProject.get(project.cwd) ?? [];
      const key = sectionKey("project", project.cwd);
      result.push({
        project,
        cwd: project.cwd,
        name: project.name,
        key,
        items: applyManualOrder(sortSessions(items), sidebarOrder?.[key]),
      });
    }
    return result;
  }, [conversations, pinned, archived, projects, sidebarOrder]);

  // Conversations with no project live here so they stay reachable without a project group.
  const recent = useMemo(() => {
    const unbound = conversations
      .filter((item) => !item.project && item.preview)
      .filter((item) => pinned[item.id] === undefined && !archived.has(item.id));
    return applyManualOrder(sortSessions(unbound), sidebarOrder?.[sectionKey("recent")]);
  }, [conversations, pinned, archived, sidebarOrder]);

  // Maps every draggable row to the section it lives in, so a drag can only ever
  // reorder within its own list. Projects are one list of their own, under `projects`.
  const sections = useMemo(() => {
    const map = new Map<string, DragSection>();
    const record = (key: string, ids: string[]): void => {
      const section: DragSection = { key, ids };
      for (const id of ids) map.set(id, section);
    };
    record(sectionKey("pinned"), pinnedItems.map((item) => item.id));
    for (const group of groups) record(group.key, group.items.map((item) => item.id));
    record(sectionKey("recent"), recent.map((item) => item.id));
    record(PROJECTS_SECTION, groups.map((group) => group.cwd));
    return map;
  }, [pinnedItems, groups, recent]);

  // Rows are the droppables; a drag only considers the rows of its own section, so
  // the insertion line can never appear in another list. `closestCenter` over the
  // rows' own rects keeps the target stable as the pointer moves.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const section = sections.get(String(args.active.id));
      if (!section) return [];
      const allowed = new Set(section.ids);
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => allowed.has(String(container.id))),
      });
    },
    [sections],
  );

  function handleDragStart(event: DragStartEvent): void {
    const section = sections.get(String(event.active.id));
    if (!section) return;
    setDrag({ id: String(event.active.id), section });
    lastDrop.current = null;
    setDrop(null);
  }

  /** Turn the row under the pointer into an insert position. The dragged row's centre
   *  compared to the target row's centre decides whether the line sits above or below,
   *  so the index is expressed in the current (unmoving) list. A position that would
   *  leave the list unchanged (the dragged row's own slot, above or below) is not a
   *  real drop, so it reports no indicator and draws no line.
   */
  function indicatorFor(event: DragMoveEvent | DragEndEvent): DropIndicator | null {
    const section = sections.get(String(event.active.id));
    if (!section || !event.over) return null;
    const overIndex = section.ids.indexOf(String(event.over.id));
    if (overIndex < 0) return null;
    const overRect = event.over.rect;
    // dnd-kit clears `translated` just before firing DragEnd in some versions. Using
    // the target's top in that case made a project dropped below another project look
    // like a drop above it (and, when it landed back on its own row, a no-op). Rebuild
    // the final active rect from the initial rect plus the pointer delta instead.
    const translated = event.active.rect.current.translated;
    const initial = event.active.rect.current.initial;
    const activeTop = translated?.top ?? (initial ? initial.top + event.delta.y : overRect.top);
    const activeHeight = translated?.height ?? initial?.height ?? overRect.height;
    const activeMiddle = activeTop + activeHeight / 2;
    const below = activeMiddle > overRect.top + overRect.height / 2;
    const index = below ? overIndex + 1 : overIndex;
    const from = section.ids.indexOf(String(event.active.id));
    // `index === from` is just above the source and `index === from + 1` just below
    // it; both resolve back to the same slot, so the drag would be a no-op.
    if (from >= 0 && (index === from || index === from + 1)) return null;
    return {
      key: section.key,
      index,
      edge: below ? "below" : "above",
      rect: { top: overRect.top, bottom: overRect.bottom, left: overRect.left, width: overRect.width },
    };
  }

  function handleDragEnd(event: DragEndEvent): void {
    // `over` can be null on the final event even though the preceding move had a
    // valid target. Prefer that final calculation, then fall back to the last one.
    const indicator = indicatorFor(event) ?? lastDrop.current;
    lastDrop.current = null;
    setDrag(null);
    setDrop(null);
    if (!indicator) return;
    const section = sections.get(String(event.active.id));
    if (!section) return;
    const from = section.ids.indexOf(String(event.active.id));
    if (from < 0) return;
    // The indicator counts insert positions in the current list, so dropping below
    // the source itself shifts by one once the source is lifted out.
    const to = indicator.index > from ? indicator.index - 1 : indicator.index;
    if (to === from) return;
    const next = arrayMove(section.ids, from, to);
    // Projects are persisted in the catalog; every conversation section keeps its
    // order under its own `sidebarOrder` key, so a drag inside one list cannot
    // disturb 置顶, 聊天 or any other project.
    if (section.key === PROJECTS_SECTION) onReorderProjects(next);
    else updateSettings({ sidebarOrder: { ...(sidebarOrder ?? {}), [section.key]: next } });
  }

  function renderSession(item: Conversation, leadSlot = true): JSX.Element {
    return (
      <DraggableSession
        key={item.id}
        item={item}
        active={item.id === activeId}
        isPinned={pinned[item.id] !== undefined}
        showSpinner={running[item.id] === true}
        waiting={waitingForUser[item.id] === true}
        failed={failedInBackground[item.id] === true}
        renamingThis={renaming?.type === "session" && renaming.id === item.id}
        leadSlot={leadSlot}
        onOpen={() => {
          onOpen(item.id);
          dismissDrawer();
        }}
        onTogglePin={() => togglePinned(item.id)}
        onFork={() => onFork(item.id)}
        onArchive={() => onArchive(item.id)}
        onStartRename={() => setRenaming({ type: "session", id: item.id })}
        onRename={(title) => {
          onRenameSession(item.id, title);
          setRenaming(null);
        }}
        onCancelRename={() => setRenaming(null)}
      />
    );
  }

  function renderSessionList(items: Conversation[], leadSlot = true): JSX.Element {
    return <div className="space-y-0.5">{items.map((item) => renderSession(item, leadSlot))}</div>;
  }

  function toggleProjectExpanded(cwd: string): void {
    const next = new Set(expandedProjects);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    updateSettings({ sidebarExpandedProjects: [...next] });
  }

  function renderProjectSessions(cwd: string, items: Conversation[]): JSX.Element {
    if (items.length === 0) {
      return (
        <p className="flex h-8 items-center gap-2.5 pl-2 text-xs text-muted-foreground">
          <span className="size-3.5 shrink-0" />
          {t("sidebar.emptyChats")}
        </p>
      );
    }
    const expanded = expandedProjects.has(cwd);
    const limited = items.length > PROJECT_SESSION_LIMIT;
    const visible = limited && !expanded ? items.slice(0, PROJECT_SESSION_LIMIT) : items;
    return (
      <>
        {renderSessionList(visible)}
        {limited ? (
          <div className="flex h-8 items-center gap-2.5 pr-1 pl-2">
            <span className="size-3.5 shrink-0" />
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-sidebar-accent-foreground"
              onClick={() => toggleProjectExpanded(cwd)}
            >
              {expanded ? t("sidebar.collapseMore") : t("sidebar.expandMore")}
            </button>
          </div>
        ) : null}
      </>
    );
  }

  const dragSection = drag?.section ?? null;
  const draggingItem = dragSection && drag ? conversations.find((item) => item.id === drag.id) ?? null : null;
  const draggingProject = dragSection?.key === PROJECTS_SECTION && drag ? groups.find((group) => group.cwd === drag.id) ?? null : null;

  // Collapsed (dragged below the minimum width, or via the header toggle): the
  // panel collapses to zero width rather than shrinking to a sliver. The content
  // holds its resting width while it animates, so the spring clips it instead of
  // reflowing it (see the "Side panel splitters" block in `index.css`).
  const content = (
    <aside
      data-slot="panel-frame"
      className="relative flex h-full min-h-0 w-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      {/* The title row exists to sit around macOS' traffic lights; where the window
          has a title bar of its own, those controls (and the brand under them) are
          up there instead and the sidebar simply starts. */}
      {HAS_CUSTOM_TITLE_BAR ? null : (
        <div className={cn("drag-region flex h-11 shrink-0 items-center gap-0.5", HAS_TRAFFIC_LIGHTS ? "pl-22" : "pl-2")}>
          <IconButton
            size="icon-sm"
            variant="ghost"
            className="no-drag text-muted-foreground"
            label={t("sidebar.collapseSidebar")}
            shortcut={toggleSidebarShortcut}
            /*
             * `setSidebarCollapsed`, not `updateSettings`: on a narrow layout the
             * sidebar's visibility is the drawer's own state, and writing the preference
             * directly did the wrong thing twice at once — the drawer stayed open, since
             * it does not read that key, and the *desktop* this phone was connected to
             * collapsed its sidebar. This is the only control that closes the drawer now
             * that it covers the whole screen, so it has to be the one that works.
             */
            onClick={() => setSidebarCollapsed(true)}
          >
            <HugeiconsIcon strokeWidth={2} icon={PanelLeftCloseIcon} />
          </IconButton>
          <IconButton
            size="icon-sm"
            variant="ghost"
            className="no-drag text-muted-foreground"
            label={t("sidebar.back")}
            disabled={!canBack}
            onClick={back}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
          </IconButton>
          <IconButton
            size="icon-sm"
            variant="ghost"
            className="no-drag text-muted-foreground"
            label={t("sidebar.forward")}
            disabled={!canForward}
            onClick={forward}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} />
          </IconButton>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleDragStart}
        onDragMove={(event) => {
          const next = indicatorFor(event);
          lastDrop.current = next;
          setDrop(next);
        }}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          lastDrop.current = null;
          setDrag(null);
          setDrop(null);
        }}
      >
        <div className={cn("no-drag px-2", HAS_CUSTOM_TITLE_BAR && "pt-2")}>
          {HAS_CUSTOM_TITLE_BAR ? null : (
            <div className="flex h-8 items-center justify-between">
              <div className="flex items-center gap-2 px-2">
                <AppLogo className="size-5 shrink-0 rounded-md" />
                <span className="text-sm font-semibold tracking-tight">FastVibe</span>
              </div>
              <div className="flex items-center gap-0.5">
                <IconButton
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  label={t("sidebar.search")}
                  shortcut={searchShortcut}
                  onClick={() => {
                    onSearch();
                    dismissDrawer();
                  }}
                >
                  <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
                </IconButton>
              </div>
            </div>
          )}

          <div className={cn("space-y-0.5", HAS_CUSTOM_TITLE_BAR ? null : "mt-1")}>
            <button
              type="button"
              className="flex h-8 pointer-coarse:h-10 w-full items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sidebar-accent/50"
              onClick={() => {
                onNewChat();
                dismissDrawer();
              }}
            >
              <HugeiconsIcon strokeWidth={2} icon={MessageSquarePlusIcon} className="size-3.5 text-muted-foreground" />
              {t("workspace.newChat")}
            </button>
            <button
              type="button"
              className="flex h-8 pointer-coarse:h-10 w-full items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sidebar-accent/50"
              onClick={() => {
                onOpenMarket();
                dismissDrawer();
              }}
            >
              <HugeiconsIcon strokeWidth={2} icon={PuzzleIcon} className="size-3.5 text-muted-foreground" />
              {t("sidebar.plugins")}
            </button>
          </div>
        </div>

        <ScrollArea className="no-drag min-h-0 flex-1">
          <div className="px-2 pb-2">
            {pinnedItems.length > 0 ? (
              <>
                <SectionLabel>{t("sidebar.pinned")}</SectionLabel>
                {renderSessionList(pinnedItems, false)}
              </>
            ) : null}

            <SectionLabel
              action={
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<IconButton
                      size="icon-xs"
                      variant="ghost"
                      label={t("sidebar.newProject")}
                      className="text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/section:opacity-100 pointer-coarse:opacity-100"
                    >
                      <HugeiconsIcon strokeWidth={2} icon={Add01Icon} className="size-3.5" />
                    </IconButton>}
                  />
                  <DropdownMenuContent align="end" className="w-36 min-w-36">
                    <DropdownMenuItem onClick={onAddProject}>{t("projectDialog.local")}</DropdownMenuItem>
                    <DropdownMenuItem onClick={onAddRemoteProject}>{t("projectDialog.remote")}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              {t("sidebar.projects")}
            </SectionLabel>
            {groups.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{t("sidebar.noProjects")}</p>
            ) : (
              <div className="space-y-0.5">
                {groups.map((group, index) => {
                  const open = !collapsed.has(group.cwd);
                  const renamingProject = renaming?.type === "project" && renaming.cwd === group.cwd;
                  return (
                    <DraggableProject
                      key={group.cwd}
                      project={group.project}
                      open={open}
                      renaming={renamingProject}
                      onOpenChange={(next) => setOpen(group.cwd, next)}
                      onNewChat={() => {
                        onNewChat(group.cwd);
                        dismissDrawer();
                      }}
                      onStartRename={() => setRenaming({ type: "project", cwd: group.cwd })}
                      onRename={(next) => {
                        onRenameProject(group.cwd, next);
                        setRenaming(null);
                      }}
                      onCancelRename={() => setRenaming(null)}
                      onReveal={() => onRevealProject(group.cwd)}
                      onRemove={() => setPendingDelete({ type: "project", cwd: group.cwd, title: group.name })}
                    >
                      {renderProjectSessions(group.cwd, group.items)}
                    </DraggableProject>
                  );
                })}
              </div>
            )}

            <SectionLabel
              action={
                <IconButton
                  size="icon-xs"
                  variant="ghost"
                  label={t("sidebar.newSession")}
                  className="text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/section:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => {
                    onNewChat();
                    dismissDrawer();
                  }}
                >
                  <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-3.5" />
                </IconButton>
              }
            >
              {t("sidebar.chats")}
            </SectionLabel>
            {recent.length > 0 ? renderSessionList(recent, false) : null}
          </div>
        </ScrollArea>
        {drop ? <DropLine rect={drop.rect} edge={drop.edge} /> : null}
        <DragOverlay dropAnimation={DROP_ANIMATION}>
          {draggingProject ? (
            <LiftedProjectRow name={draggingProject.name} width={width - 16} />
          ) : draggingItem ? (
            <LiftedSessionRow item={draggingItem} width={width - 16} />
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="no-drag flex items-center gap-1 p-2">
        <button
          type="button"
          className="flex h-8 pointer-coarse:h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sidebar-accent/50"
          onClick={() => {
            onOpenSettings();
            dismissDrawer();
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Settings01Icon} className="size-3.5 text-muted-foreground" />
          {t("palette.settings")}
        </button>
        <SidebarUpdateButton />
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sidebar.removeProjectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sidebar.removeProjectDesc", { name: pendingDelete?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sidebar.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pendingDelete) return;
                onRemoveProject(pendingDelete.cwd);
                setPendingDelete(null);
              }}
            >
              {t("sidebar.removeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );

  /*
   * A full-screen drawer has no edge to drag and nothing to give width back to, and
   * a splitter would sit on top of the conversation list where a thumb scrolls. Worse,
   * its drag ended in `writeSidebarWidth`, which is the *shared* preference: one stray
   * swipe on a phone would rewrite the width of the column on the desktop it is
   * connected to. So the drawer only slides, and the desktop column gets the library's
   * splitter.
   */
  return narrow ? (
    <CollapsiblePanel collapsed={sidebarCollapsed} side="left">
      {content}
    </CollapsiblePanel>
  ) : (
    <ResizablePanel {...sidebarPanel}>{content}</ResizablePanel>
  );
});
